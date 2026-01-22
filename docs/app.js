// app.js
// Pipeline : PDF → image (canvas) → OCR → parsing JSON → export

import { parseOcrTextToProject } from "./parser.js";
import * as pdfjsLib from "./vendor/pdfjs/pdf.mjs";

/* -------------------------
   PDF.js configuration
-------------------------- */

pdfjsLib.GlobalWorkerOptions.workerSrc =
  new URL("./vendor/pdfjs/pdf.worker.mjs", import.meta.url).toString();

/* -------------------------
   DOM helpers
-------------------------- */

const $ = (id) => document.getElementById(id);

/* -------------------------
   DOM references
-------------------------- */

const pdfInput = $("pdfInput");
const pageMode = $("pageMode");
const pageFrom = $("pageFrom");
const pageTo = $("pageTo");
const dpiSel = $("dpi");
const runBtn = $("runBtn");
const resetBtn = $("resetBtn");

const statusBadge = $("statusBadge");
const statusText = $("statusText");
const progress = $("progress");

const previewCanvas = $("previewCanvas");
const ocrOut = $("ocrOut");
const jsonOut = $("jsonOut");
const logOut = $("logOut");

const dlOcrBtn = $("dlOcrBtn");
const dlJsonBtn = $("dlJsonBtn");
const dlZipBtn = $("dlZipBtn");
const baseName = $("baseName");

const tabs = Array.from(document.querySelectorAll(".tab"));
const panels = {
  ocr: $("panel-ocr"),
  json: $("panel-json"),
  log: $("panel-log"),
};

/* -------------------------
   State
-------------------------- */

let pdfArrayBuffer = null;
let pdfFileName = null;

let lastOcrText = "";
let lastParsed = null;
let lastRenderedPngDataUrl = null;

/* -------------------------
   Init
-------------------------- */

setupTabs();

pageMode.addEventListener("change", () => {
  const isRange = pageMode.value === "range";
  pageFrom.disabled = !isRange;
  pageTo.disabled = !isRange;
});

/* -------------------------
   PDF import
-------------------------- */

pdfInput.addEventListener("change", async (e) => {
  resetOutputs();
  const file = e.target.files?.[0];
  if (!file) return;

  pdfFileName = file.name.replace(/\.pdf$/i, "");
  baseName.value = pdfFileName;
  baseName.disabled = false;

  setStatus("ok", "PDF chargé", `Fichier : ${file.name}`);
  progress.value = 0;

  pdfArrayBuffer = await file.arrayBuffer();

  const pdf = await loadPdf(pdfArrayBuffer);
  pageFrom.value = 1;
  pageTo.value = pdf.numPages;

  runBtn.disabled = false;
  resetBtn.disabled = false;

  await renderPageToPreview(pdf, 1, getDpi());
  pdf.destroy?.();
});

/* -------------------------
   Reset
-------------------------- */

resetBtn.addEventListener("click", () => {
  pdfInput.value = "";
  pdfArrayBuffer = null;
  pdfFileName = null;
  baseName.value = "";
  baseName.disabled = true;
  runBtn.disabled = true;
  resetBtn.disabled = true;
  resetOutputs();
  setStatus("idle", "En attente", "Importez un PDF.");
  progress.value = 0;
});

/* -------------------------
   Run OCR + parsing
-------------------------- */

runBtn.addEventListener("click", async () => {
  if (!pdfArrayBuffer) return;

  try {
    resetOutputs();
    setStatus("work", "Traitement", "Initialisation…");
    progress.value = 0;

    const pdf = await loadPdf(pdfArrayBuffer);
    const pages = computePagesToProcess(pdf.numPages);
    log(`Pages à traiter : ${pages.join(", ")}`);

    const worker = await createTesseractWorker();

    let fullText = "";

    for (let i = 0; i < pages.length; i++) {
      const pno = pages[i];
      setStatus("work", "OCR", `Page ${pno}/${pdf.numPages}`);

      const { pngDataUrl } = await renderPdfPageToImage(pdf, pno, getDpi());
      lastRenderedPngDataUrl = pngDataUrl;

      if (i === 0) {
        await drawDataUrlToCanvas(pngDataUrl, previewCanvas);
      }

      const ocrText = await recognizeWithProgress(worker, pngDataUrl, (pct) => {
        const base = Math.round((i / pages.length) * 100);
        const step = Math.round((pct / 100) * (100 / pages.length));
        progress.value = Math.min(99, base + step);
      });

      fullText += `\n===== PAGE ${pno} =====\n${ocrText.trim()}\n`;
      log(`Page ${pno} OCR OK (${ocrText.length} caractères)`);
    }

    await worker.terminate();
    pdf.destroy?.();

    lastOcrText = fullText.trim();
    ocrOut.value = lastOcrText;

    setStatus("work", "Parsing", "Analyse APS…");
    lastParsed = parseOcrTextToProject(lastOcrText);
    jsonOut.value = JSON.stringify(lastParsed, null, 2);

    setStatus("ok", "Terminé", "OCR + parsing effectués");
    progress.value = 100;

    dlOcrBtn.disabled = false;
    dlJsonBtn.disabled = false;
    dlZipBtn.disabled = false;

    activateTab("json");
  } catch (err) {
    console.error(err);
    log(`ERREUR : ${err.message ?? err}`);
    setStatus("bad", "Erreur", "Voir logs");
    progress.value = 0;
  }
});

/* -------------------------
   Downloads
-------------------------- */

dlOcrBtn.addEventListener("click", () => {
  downloadText(`${safeBaseName()}.ocr.txt`, lastOcrText);
});

dlJsonBtn.addEventListener("click", () => {
  downloadText(
    `${safeBaseName()}.parsed.json`,
    JSON.stringify(lastParsed ?? {}, null, 2)
  );
});

dlZipBtn.addEventListener("click", async () => {
  const zip = new JSZip();
  const name = safeBaseName();

  zip.file(`${name}.ocr.txt`, lastOcrText);
  zip.file(`${name}.parsed.json`, JSON.stringify(lastParsed, null, 2));

  if (lastRenderedPngDataUrl) {
    zip.file(`${name}.page.png`, dataUrlToBlob(lastRenderedPngDataUrl));
  }

  const blob = await zip.generateAsync({ type: "blob" });
  saveAs(blob, `${name}.zip`);
});

/* -------------------------
   PDF.js helpers
-------------------------- */

async function loadPdf(arrayBuffer) {
  const task = pdfjsLib.getDocument({
    data: arrayBuffer,
    cMapUrl: new URL("./vendor/pdfjs/cmaps/", import.meta.url).toString(),
    cMapPacked: true,
    standardFontDataUrl: new URL(
      "./vendor/pdfjs/standard_fonts/",
      import.meta.url
    ).toString(),
  });
  return await task.promise;
}

function getDpi() {
  return parseInt(dpiSel.value, 10) || 200;
}

function dpiToScale(dpi) {
  return dpi / 72;
}

async function renderPageToPreview(pdf, pageNumber, dpi) {
  const { pngDataUrl } = await renderPdfPageToImage(pdf, pageNumber, dpi);
  await drawDataUrlToCanvas(pngDataUrl, previewCanvas);
}

async function renderPdfPageToImage(pdf, pageNumber, dpi) {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: dpiToScale(dpi) });

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { alpha: false });

  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);

  await page.render({ canvasContext: ctx, viewport }).promise;

  return {
    pngDataUrl: canvas.toDataURL("image/png"),
    width: canvas.width,
    height: canvas.height,
  };
}

async function drawDataUrlToCanvas(dataUrl, canvas) {
  const img = new Image();
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = rej;
    img.src = dataUrl;
  });

  canvas.width = img.width;
  canvas.height = img.height;
  canvas.getContext("2d").drawImage(img, 0, 0);
}

/* -------------------------
   Tesseract helpers
-------------------------- */

async function createTesseractWorker() {
  const worker = await Tesseract.createWorker("fra");
  await worker.setParameters({
    tessedit_char_blacklist: "¢©®™",
  });
  return worker;
}

async function recognizeWithProgress(worker, imageDataUrl, onProgress) {
  const { data } = await worker.recognize(imageDataUrl, {
    logger: (m) => {
      if (m.status === "recognizing text" && m.progress != null) {
        onProgress(Math.round(m.progress * 100));
      }
    },
  });
  return data.text || "";
}

/* -------------------------
   Pages selection
-------------------------- */

function computePagesToProcess(numPages) {
  if (pageMode.value === "all") {
    return Array.from({ length: numPages }, (_, i) => i + 1);
  }
  if (pageMode.value === "range") {
    let a = parseInt(pageFrom.value, 10) || 1;
    let b = parseInt(pageTo.value, 10) || 1;
    a = Math.max(1, Math.min(numPages, a));
    b = Math.max(1, Math.min(numPages, b));
    if (b < a) [a, b] = [b, a];
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  }
  return [1];
}

/* -------------------------
   UI / utils
-------------------------- */

function setStatus(kind, badge, msg) {
  statusBadge.textContent = badge;
  statusText.textContent = msg;
}

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  logOut.textContent += `[${ts}] ${msg}\n`;
}

function resetOutputs() {
  ocrOut.value = "";
  jsonOut.value = "";
  logOut.textContent = "";
  lastOcrText = "";
  lastParsed = null;
  lastRenderedPngDataUrl = null;
  dlOcrBtn.disabled = true;
  dlJsonBtn.disabled = true;
  dlZipBtn.disabled = true;
  activateTab("ocr");
}

function safeBaseName() {
  return (baseName.value || "plan").trim().replace(/[^\w\-\.]+/g, "_");
}

function downloadText(name, content) {
  saveAs(new Blob([content], { type: "text/plain;charset=utf-8" }), name);
}

function dataUrlToBlob(dataUrl) {
  const [meta, b64] = dataUrl.split(",");
  const mime = /data:(.*?);base64/.exec(meta)?.[1];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

/* -------------------------
   Tabs
-------------------------- */

function setupTabs() {
  tabs.forEach((t) =>
    t.addEventListener("click", () => activateTab(t.dataset.tab))
  );
}

function activateTab(name) {
  tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  Object.entries(panels).forEach(([k, el]) =>
    el.classList.toggle("active", k === name)
  );
}
