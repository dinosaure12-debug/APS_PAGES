// app.js
// “Pipeline” = enchaînement d’étapes : PDF → image (canvas) → OCR → parsing JSON → export.

import { parseOcrTextToProject } from "./parser.js";
const pdfjsLib = window.pdfjsLib;

if (!pdfjsLib) {
  throw new Error("PDF.js n'est pas chargé : window.pdfjsLib est undefined. Vérifie le script CDN pdf.min.js.");
}

// Worker PDF.js (version identique à celle du pdf.min.js)
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.worker.min.js";

const $ = (id) => document.getElementById(id);

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

let pdfArrayBuffer = null;
let pdfFileName = null;

let lastOcrText = "";
let lastParsed = null;
let lastRenderedPngDataUrl = null;

setupTabs();

pageMode.addEventListener("change", () => {
  const mode = pageMode.value;
  const isRange = mode === "range";
  pageFrom.disabled = !isRange;
  pageTo.disabled = !isRange;
});

pdfInput.addEventListener("change", async (e) => {
  resetOutputs();
  const file = e.target.files?.[0];
  if (!file) return;

  pdfFileName = file.name.replace(/\.pdf$/i, "");
  baseName.value = pdfFileName;
  baseName.disabled = false;

  setStatus("ok", "PDF chargé", `Fichier: ${file.name}`);
  progress.value = 0;

  pdfArrayBuffer = await file.arrayBuffer();

  // On lit le PDF pour connaitre le nombre de pages (PDF.js).
  const pdf = await loadPdf(pdfArrayBuffer);
  pageTo.value = pdf.numPages;
  pageFrom.value = 1;

  runBtn.disabled = false;
  resetBtn.disabled = false;

  // Preview : on rend la page 1
  await renderPageToPreview(pdf, 1, getDpi());
  pdf.destroy?.();
});

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

runBtn.addEventListener("click", async () => {
  if (!pdfArrayBuffer) return;

  try {
    resetOutputs();
    setStatus("work", "Traitement", "Initialisation…");
    progress.value = 0;

    const pdf = await loadPdf(pdfArrayBuffer);

    const pages = computePagesToProcess(pdf.numPages);
    log(`Pages à traiter: ${pages.join(", ")}`);

    // “Web Worker” = fil d’exécution séparé (évite de bloquer l’interface).
    const worker = await createTesseractWorker();

    let fullText = "";
    for (let i = 0; i < pages.length; i++) {
      const pno = pages[i];
      setStatus("work", "OCR", `Rendu + OCR page ${pno}/${pdf.numPages}…`);

      // 1) Render PDF page to image (canvas)
      const { pngDataUrl } = await renderPdfPageToImage(pdf, pno, getDpi());

      // conserver un aperçu de la dernière page rendue
      lastRenderedPngDataUrl = pngDataUrl;
      if (pno === pages[0]) {
        // preview = première page analysée
        await drawDataUrlToCanvas(pngDataUrl, previewCanvas);
      }

      // 2) OCR
      const ocrText = await recognizeWithProgress(worker, pngDataUrl, (pct) => {
        const base = Math.round(((i) / pages.length) * 100);
        const step = Math.round((pct / 100) * (100 / pages.length));
        progress.value = Math.min(99, base + step);
      });

      fullText += `\n===== PAGE ${pno} =====\n` + ocrText.trim() + "\n";

      log(`Page ${pno} OCR ok (chars: ${ocrText.length}).`);
    }

    await worker.terminate();
    pdf.destroy?.();

    lastOcrText = fullText.trim();
    ocrOut.value = lastOcrText;

    setStatus("work", "Parsing", "Application des règles…");
    lastParsed = parseOcrTextToProject(lastOcrText);
    jsonOut.value = JSON.stringify(lastParsed, null, 2);

    setStatus("ok", "Terminé", "OCR + parsing effectués.");
    progress.value = 100;

    dlOcrBtn.disabled = false;
    dlJsonBtn.disabled = false;
    dlZipBtn.disabled = false;

    // par défaut, on se place sur l’onglet JSON (utile en test)
    activateTab("json");
  } catch (err) {
    console.error(err);
    log(`ERREUR: ${err?.message ?? String(err)}`);
    setStatus("bad", "Erreur", "Voir logs.");
    progress.value = 0;
  }
});

dlOcrBtn.addEventListener("click", () => {
  const name = safeBaseName();
  downloadText(`${name}.ocr.txt`, lastOcrText || "");
});

dlJsonBtn.addEventListener("click", () => {
  const name = safeBaseName();
  downloadText(`${name}.parsed.json`, JSON.stringify(lastParsed ?? {}, null, 2));
});

dlZipBtn.addEventListener("click", async () => {
  const name = safeBaseName();
  const zip = new JSZip();

  zip.file(`${name}.ocr.txt`, lastOcrText || "");
  zip.file(`${name}.parsed.json`, JSON.stringify(lastParsed ?? {}, null, 2));

  // Ajout d’un rendu image si dispo (utile pour QA)
  if (lastRenderedPngDataUrl) {
    const blob = dataUrlToBlob(lastRenderedPngDataUrl);
    zip.file(`${name}.page.png`, blob);
  }

  const content = await zip.generateAsync({ type: "blob" });
  saveAs(content, `${name}.zip`);
});

/* -------------------------
   PDF.js helpers
-------------------------- */

async function loadPdf(arrayBuffer) {
  // PDF.js a besoin d’un “worker” (script séparé) pour parser le PDF.
  // On le déclare ici via CDN.
  // “workerSrc” = chemin du script de worker.
  const workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.worker.min.js";
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  return await loadingTask.promise;
}

function getDpi() {
  return parseInt(dpiSel.value, 10) || 200;
}

// Conversion DPI → scale PDF.js
// PDF.js travaille en “points” (72 DPI). scale = DPI / 72.
function dpiToScale(dpi) {
  return dpi / 72;
}

async function renderPageToPreview(pdf, pageNumber, dpi) {
  const { pngDataUrl } = await renderPdfPageToImage(pdf, pageNumber, dpi);
  await drawDataUrlToCanvas(pngDataUrl, previewCanvas);
}

async function renderPdfPageToImage(pdf, pageNumber, dpi) {
  const page = await pdf.getPage(pageNumber);
  const scale = dpiToScale(dpi);
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { alpha: false });

  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);

  await page.render({ canvasContext: ctx, viewport }).promise;

  const pngDataUrl = canvas.toDataURL("image/png");
  return { pngDataUrl, width: canvas.width, height: canvas.height };
}

async function drawDataUrlToCanvas(dataUrl, canvas) {
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = dataUrl;
  });

  const ctx = canvas.getContext("2d", { alpha: false });
  canvas.width = img.width;
  canvas.height = img.height;
  ctx.drawImage(img, 0, 0);
}

/* -------------------------
   Tesseract.js helpers
-------------------------- */

async function createTesseractWorker() {
  // “OCR” = reconnaissance de caractères. Tesseract.js fait cela côté navigateur.
  // lang = "fra" pour français. (On peut ajouter "eng" ensuite si besoin.)
  const worker = await Tesseract.createWorker("fra");
  await worker.setParameters({
    // améliore parfois les plans : on évite de trop “inventer” des caractères
    tessedit_char_blacklist: "¢©®™",
  });
  return worker;
}

async function recognizeWithProgress(worker, imageDataUrl, onProgress) {
  const { data } = await worker.recognize(imageDataUrl, {
    logger: (m) => {
      if (m.status === "recognizing text" && typeof m.progress === "number") {
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
  const mode = pageMode.value;
  if (mode === "all") {
    return Array.from({ length: numPages }, (_, i) => i + 1);
  }
  if (mode === "range") {
    let a = parseInt(pageFrom.value, 10) || 1;
    let b = parseInt(pageTo.value, 10) || 1;
    a = Math.max(1, Math.min(numPages, a));
    b = Math.max(1, Math.min(numPages, b));
    if (b < a) [a, b] = [b, a];
    const out = [];
    for (let p = a; p <= b; p++) out.push(p);
    return out;
  }
  // first
  return [1];
}

/* -------------------------
   UI / logs / downloads
-------------------------- */

function setStatus(kind, badgeText, msg) {
  statusBadge.textContent = badgeText;
  statusText.textContent = msg;

  statusBadge.style.borderColor = "var(--border)";
  statusBadge.style.color = "var(--muted)";

  if (kind === "ok") {
    statusBadge.style.borderColor = "var(--ok)";
    statusBadge.style.color = "var(--ok)";
  } else if (kind === "work") {
    statusBadge.style.borderColor = "var(--warn)";
    statusBadge.style.color = "var(--warn)";
  } else if (kind === "bad") {
    statusBadge.style.borderColor = "var(--bad)";
    statusBadge.style.color = "var(--bad)";
  }
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
  const v = (baseName.value || "plan").trim();
  return v.replace(/[^\w\-\.]+/g, "_");
}

function downloadText(filename, content) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  saveAs(blob, filename);
}

function dataUrlToBlob(dataUrl) {
  const [meta, b64] = dataUrl.split(",");
  const mime = /data:(.*?);base64/.exec(meta)?.[1] || "application/octet-stream";
  const bin = atob(b64);
  const len = bin.length;
  const arr = new Uint8Array(len);
  for (let i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

/* -------------------------
   Tabs
-------------------------- */

function setupTabs() {
  for (const t of tabs) {
    t.addEventListener("click", () => activateTab(t.dataset.tab));
  }
}

function activateTab(name) {
  for (const t of tabs) t.classList.toggle("active", t.dataset.tab === name);
  for (const [k, el] of Object.entries(panels)) el.classList.toggle("active", k === name);
}

