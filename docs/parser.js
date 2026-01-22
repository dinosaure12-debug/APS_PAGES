// parser.js
// Ici, on “porte” votre parseur Python en JavaScript.
// “Porter” = réécrire la même logique dans un autre langage, sans changer le comportement métier.

export function parseOcrTextToProject(textRaw) {
  const text = (textRaw ?? "").toString();

  const poste = parsePosteNumero(text);
  const insee = poste ? deriveInseeFromPoste(poste) : null;

  const htaItems = extractExtensionsHta(text);
  const btReprises = extractReprisesBt(text);
  const btRaccord = extractRaccordementBt(text);
  const posteTravaux = extractPosteDpTravaux(text);

  const pdls = extractPdls(text);

  // Option 2 validée : affaire alignée sur le 1er PDL si présent
  const affaireNum = pdls.length ? pdls[0].num_affaire : extractAffaireNum(text);
  const affaireP = pdls.length ? pdls[0].p_prod_kva : extractGlobalPKva(text);

  return {
    affaire: { num: affaireNum, p_kva: affaireP },
    poste_dp: {
      numero: poste,
      insee,
      travaux: posteTravaux,
    },
    hta: shapeSingleOrMany("extension", "extensions", htaItems),
    bt: {
      ...shapeSingleOrMany("reprise", "reprises", btReprises),
      raccordement: btRaccord,
    },
    pdls,
  };
}

/* ============================================================
   Helpers / référentiels
============================================================ */

const POSTE_TYPES = new Set(["H61", "PRCS", "RC", "PAC", "PUIE", "CH", "CB"]);
const POSTE_PUISSANCES = new Set([50, 100, 160, 250, 400, 630, 1000]);

function shapeSingleOrMany(keySingular, keyPlural, items) {
  const arr = Array.isArray(items) ? items : [];
  if (arr.length === 0) return { [keySingular]: null };
  if (arr.length === 1) return { [keySingular]: arr[0] };
  return { [keyPlural]: arr };
}

function normalizeSection(raw) {
  if (!raw) return "";
  let s = raw.trim().replace(/\s+/g, " ");
  s = s.replace(/mm[\?²]/gi, "mm2");
  s = s.replace(/\bAI\b/gi, "AL"); // OCR fréquent : AI au lieu de AL
  s = s.replace(/\bAl\b/g, "AL");
  return s;
}

/* ============================================================
   Regex de base
   “Regex” = expression régulière : un langage pour “matcher” des motifs de texte.
============================================================ */

const RAC_RE = /\bRAC-[A-Z]{3}-\d{2}-\d{6}\b/g;
const RAC_ONE_RE = /\bRAC-[A-Z]{3}-\d{2}-\d{6}\b/;

const P_KVA_RE = /\bP\s*=\s*(\d{1,4})\s*KVA\b/i;

const SECTION_RE = /(?<section>3x\s*\d+(?:\s*mm[²2\?]?)?(?:\s*\+\s*1x\s*\d+(?:\s*mm[²2\?]?)?)?\s*A[IL])/ig;
const LENGTH_RE = /(\d{1,4})\s*m\b|(\d{1,4})m\b/i;

const JONCTION_RE = /(?:via|par|avec)?\s*(?:(?<n>\d+)\s+)?jonction(?:s)?\b/ig;
const REMONTEE_RE = /(?:via|par|avec)?\s*(?:(?<n>\d+)\s+)?remont[ée]e(?:s)?\s+a[ée]ro[-\s]?souterraine(?:s)?\b/ig;
const RAS_RE = /\bRAS\b/i;

const PALIER_RE = /\b(50|100|160|250|400|630|1000)\b/g;

const SURPLUS_RE = /\bSURPLUS\b/i;
const PRM14_RE = /\b\d{14}\b/;
const PCONSO_VAL_RE = /(?:P\s*conso|Pconso)\s*(?:=|:)?\s*(\d{1,4})\s*KVA\b/i;

/* ============================================================
   Poste DP / INSEE
============================================================ */

// Ex: 09152P0001, 12450P0021
const POSTE_RE = /\b(\d{5})P(\d{4})\b/;

function parsePosteNumero(text) {
  const m = (text ?? "").match(POSTE_RE);
  return m ? m[0] : null;
}

function deriveInseeFromPoste(poste) {
  // INSEE = 5 premiers chiffres, zéro compris
  const m = (poste ?? "").match(/^(\d{5})P\d{4}$/);
  return m ? m[1] : null;
}

/* ============================================================
   Affaire globale (fallback)
============================================================ */

function extractAffaireNum(text) {
  const m = (text ?? "").match(RAC_ONE_RE);
  return m ? m[0] : null;
}

function extractGlobalPKva(text) {
  const m = (text ?? "").match(P_KVA_RE);
  if (!m) return null;
  const v = parseInt(m[1], 10);
  return Number.isFinite(v) ? v : null;
}

/* ============================================================
   Accessoires (local)
============================================================ */

function extractAccessoires(txt) {
  const acc = { jonctions: 0, remontees_aero_souterraines: 0, ras: false };
  if (!txt) return acc;

  if (RAS_RE.test(txt)) acc.ras = true;

  let maxJ = 0;
  for (const m of txt.matchAll(JONCTION_RE)) {
    const n = m.groups?.n;
    const val = n ? parseInt(n, 10) : 1;
    if (Number.isFinite(val)) maxJ = Math.max(maxJ, val);
  }
  acc.jonctions = maxJ;

  let maxR = 0;
  for (const m of txt.matchAll(REMONTEE_RE)) {
    const n = m.groups?.n;
    const val = n ? parseInt(n, 10) : 1;
    if (Number.isFinite(val)) maxR = Math.max(maxR, val);
  }
  acc.remontees_aero_souterraines = maxR;

  return acc;
}

function localWindow(bloc, span, before = 500, after = 600) {
  if (!bloc || !span) return bloc || "";
  const [s, e] = span;
  const a = Math.max(0, s - before);
  const b = Math.min(bloc.length, e + after);
  return bloc.slice(a, b);
}

/* ============================================================
   Paires longueur + section (avec spans)
============================================================ */

function findPairsWithSpans(bloc) {
  const items = [];
  if (!bloc) return items;

  for (const sm of bloc.matchAll(SECTION_RE)) {
    const secRaw = sm.groups?.section ?? sm[0];
    const sec = normalizeSection(secRaw);

    const sIdx = sm.index ?? 0;
    const eIdx = sIdx + sm[0].length;

    const winStart = Math.max(0, sIdx - 320);
    const contextBefore = bloc.slice(winStart, sIdx);

    if (!/c[âa]ble/i.test(contextBefore)) continue;

    // dernière longueur avant la section
    const matches = Array.from(contextBefore.matchAll(new RegExp(LENGTH_RE, "ig")));
    if (!matches.length) continue;

    const lm = matches[matches.length - 1];
    const val = lm[1] || lm[2];
    const longueur = parseInt(val, 10);
    if (!Number.isFinite(longueur)) continue;

    items.push({
      longueur_m: longueur,
      section: sec,
      liaison: "RAS",
      _has_plus_1x: /\+1x/i.test(sec),
      _span: [sIdx, eIdx],
    });
  }

  return items;
}

/* ============================================================
   HTA : blocs bornés ("Extension ... HTA" -> "poste source")
============================================================ */

const HTA_START_RE = /Extension\s+du\s+r[ée]seau\s+HTA/ig;
const HTA_END_RE = /(?:\bdu\s+)?poste[-\s]+source\b/ig;

function extractBlocks(text, startRe, endRe) {
  if (!text) return [];
  const starts = Array.from(text.matchAll(startRe)).map(m => m.index ?? 0);
  if (!starts.length) return [];

  const blocks = [];
  for (const s of starts) {
    const after = text.slice(s);
    endRe.lastIndex = 0;
    const mend = endRe.exec(after);
    if (!mend) continue;
    const e = s + (mend.index ?? 0) + mend[0].length;
    blocks.push(text.slice(s, e));
  }
  return blocks;
}

export function extractExtensionsHta(text) {
  const items = [];
  if (!text) return items;

  const blocks = extractBlocks(text, HTA_START_RE, HTA_END_RE);
  for (const bloc of blocks) {
    const pairs = findPairsWithSpans(bloc);
    for (const p of pairs) {
      if (p._has_plus_1x) continue; // heuristique : HTA généralement sans +1x
      const local = localWindow(bloc, p._span);
      const acc = extractAccessoires(local);
      items.push({
        longueur_m: p.longueur_m,
        section: p.section,
        liaison: "RAS",
        accessoires: acc,
      });
    }
  }

  // Fallback : si peu d’info, tenter autour de "HTA"
  if (items.length <= 1) {
    for (const hm of (text.matchAll(/\bHTA\b/ig))) {
      const idx = hm.index ?? 0;
      const a = Math.max(0, idx - 700);
      const b = Math.min(text.length, idx + 1100);
      const zone = text.slice(a, b);

      const pairs = findPairsWithSpans(zone);
      for (const p of pairs) {
        if (p._has_plus_1x) continue;
        const local = localWindow(zone, p._span);
        const acc = extractAccessoires(local);
        const cand = {
          longueur_m: p.longueur_m,
          section: p.section,
          liaison: "RAS",
          accessoires: acc,
        };
        if (!items.some(x => x.longueur_m === cand.longueur_m && x.section === cand.section)) {
          items.push(cand);
        }
      }
    }
  }

  return items;
}

/* ============================================================
   BT reprise : "Reprise ..." -> marqueur de fin
============================================================ */

const BT_REPRISE_START_RE = /Reprise\s+du\s+r[ée]seau\s+BT\s+existant/ig;
const BT_END_RE = /\b(?:Raccordement\s+en\b|Déplacement\s+du\s+poste\s+DP\b|Deplacement\s+du\s+poste\s+DP\b|Extension\s+du\s+r[ée]seau\s+HTA\b|LEGENDE\b)\b/i;
const BT_FUSIBLES_RE = /fusibles?\s*(?<fusibles>\d{2,4})\s*A\b/i;

function extractReprisesBt(text) {
  const items = [];
  if (!text) return items;

  for (const ms of text.matchAll(BT_REPRISE_START_RE)) {
    const start = ms.index ?? 0;
    const after = text.slice(start);
    const me = after.match(BT_END_RE);
    const bloc = me ? after.slice(0, me.index ?? 0) : after.slice(0, 1600);

    const mf = bloc.match(BT_FUSIBLES_RE);
    const protection = mf?.groups?.fusibles ? parseInt(mf.groups.fusibles, 10) : null;

    const pairs = findPairsWithSpans(bloc);
    for (const p of pairs) {
      const local = localWindow(bloc, p._span);
      const acc = extractAccessoires(local);
      items.push({
        longueur_m: p.longueur_m,
        section: p.section,
        protection_a: Number.isFinite(protection) ? protection : null,
        liaison: "RAS",
        accessoires: acc,
      });
    }
  }
  return items;
}

/* ============================================================
   BT raccordement : "Raccordement en" ... "A)"
============================================================ */

const RACCORD_START_RE = /\bRaccordement\s+en\b/i;
const RACCORD_END_RE = /\bA\)/i;
const RACCORD_FALLBACK_END_RE = /\b(?:Protection\b|Déplacement\s+du\s+poste\s+DP\b|Deplacement\s+du\s+poste\s+DP\b|Reprise\s+du\s+r[ée]seau\s+BT\s+existant\b|Extension\s+du\s+r[ée]seau\s+HTA\b|LEGENDE\b)\b/i;

function detectTypeRaccordement(bloc) {
  const b = (bloc || "").toLowerCase();
  if (b.includes("départ direct") || b.includes("depart direct")) return "depart_direct";
  if (b.includes("dérivation") || b.includes("derivation")) return "derivation";
  return null;
}

function extractSectionOnly(bloc) {
  const m = (bloc || "").match(SECTION_RE);
  if (!m) return null;
  // m[0] peut être la section ; normalize
  return normalizeSection(m[0]);
}

function extractLengthOnly(bloc) {
  const m = (bloc || "").match(LENGTH_RE);
  if (!m) return null;
  const val = m[1] || m[2];
  const v = parseInt(val, 10);
  return Number.isFinite(v) ? v : null;
}

function extractRaccordementBt(text) {
  if (!text) return null;
  const mstart = text.match(RACCORD_START_RE);
  if (!mstart) return null;

  const startIdx = mstart.index ?? text.toLowerCase().indexOf("raccordement en");
  const after = text.slice(startIdx);

  let bloc = after;
  const mend = after.match(RACCORD_END_RE);
  if (mend && mend.index != null) {
    bloc = after.slice(0, mend.index + mend[0].length);
  } else {
    const mend2 = after.match(RACCORD_FALLBACK_END_RE);
    if (mend2 && mend2.index != null) bloc = after.slice(0, mend2.index);
    else bloc = after.slice(0, 1200);
  }

  const typ = detectTypeRaccordement(bloc);
  const section = extractSectionOnly(bloc);
  const longueur = extractLengthOnly(bloc);

  const acc = extractAccessoires(bloc);

  if (typ == null && section == null && longueur == null) return null;

  return {
    type_raccordement: typ,
    section,
    longueur_m: longueur,
    accessoires: acc,
  };
}

/* ============================================================
   Poste DP : Option C (couples type+palier + fallback)
============================================================ */

const POSTE_EVT_START_RE = /\b(D[ée]placement|Cr[ée]ation|Adaptation|Mutation)\s+du\s+poste\s+DP\b/i;
const POSTE_EVT_END_RE = /\bprise\s*1\b/i;

const POSTE_TYPE_APRES_RE = /\badaptation\s+en\s+type\s+(?<type>[A-Z0-9\-]{2,10})\b/i;

function normTypePoste(raw) {
  if (!raw) return null;
  const s = raw.toUpperCase();
  if (/\bCABINE\s+HAUTE\b/.test(s)) return "CH";
  if (/\bCABINE\s+BASSE\b/.test(s)) return "CB";
  for (const code of POSTE_TYPES) {
    const re = new RegExp(`\\b${code}\\b`, "i");
    if (re.test(s)) return code;
  }
  return null;
}

function extractFirstPosteBlock(text) {
  const m = text.match(POSTE_EVT_START_RE);
  if (!m) return null;
  const start = m.index ?? 0;
  const after = text.slice(start);
  const me = after.match(POSTE_EVT_END_RE);
  return me && me.index != null ? after.slice(0, me.index + me[0].length) : after.slice(0, 2200);
}

function firstPalierInWindow(txt) {
  const m = (txt || "").match(_palierOne());
  if (!m) return null;
  const v = parseInt(m[1], 10);
  return POSTE_PUISSANCES.has(v) ? v : null;
}
function _palierOne() {
  return /\b(50|100|160|250|400|630|1000)\b/;
}

function scanTypeOccurrences(bloc) {
  const occ = [];
  if (!bloc) return occ;

  for (const m of bloc.matchAll(/\bCABINE\s+HAUTE\b/ig)) occ.push([m.index ?? 0, "CH"]);
  for (const m of bloc.matchAll(/\bCABINE\s+BASSE\b/ig)) occ.push([m.index ?? 0, "CB"]);

  for (const code of POSTE_TYPES) {
    const re = new RegExp(`\\b${code}\\b`, "ig");
    for (const m of bloc.matchAll(re)) occ.push([m.index ?? 0, code]);
  }

  occ.sort((a, b) => a[0] - b[0]);
  return occ;
}

function buildTypePowerPairs(bloc) {
  const pairs = [];
  const occ = scanTypeOccurrences(bloc);
  for (const [pos, code] of occ) {
    const a = Math.max(0, pos - 60);
    const b = Math.min(bloc.length, pos + 180);
    const window = bloc.slice(a, b);
    const p = firstPalierInWindow(window);
    pairs.push({ pos, code, puissance_kva: p });
  }

  // dédup OCR proche
  const dedup = [];
  for (const x of pairs) {
    if (!dedup.length) { dedup.push(x); continue; }
    const prev = dedup[dedup.length - 1];
    if (x.code === prev.code && Math.abs(x.pos - prev.pos) < 40) {
      if (prev.puissance_kva == null && x.puissance_kva != null) dedup[dedup.length - 1] = x;
      continue;
    }
    dedup.push(x);
  }
  return dedup;
}

function fallbackTypeAvantPower(bloc) {
  const m = bloc.match(/\bde\s+type\b/i);
  if (!m) return [null, null];
  const idx = (m.index ?? 0) + m[0].length;
  const window = bloc.slice(idx, idx + 260);
  const t = normTypePoste(window);
  const p = firstPalierInWindow(window);
  return [t, p];
}

function fallbackTypeApresPower(bloc) {
  const m = bloc.match(/d['’]une\s+puissance\s+de/i);
  if (m) {
    const idx = (m.index ?? 0) + m[0].length;
    const window = bloc.slice(idx, idx + 90);
    return firstPalierInWindow(window);
  }
  const vals = Array.from(bloc.matchAll(PALIER_RE)).map(x => parseInt(x[1], 10)).filter(v => POSTE_PUISSANCES.has(v));
  return vals.length ? Math.max(...vals) : null;
}

function extractPosteDpTravaux(text) {
  const bloc = extractFirstPosteBlock(text);
  if (!bloc) return null;

  const mOp = bloc.match(POSTE_EVT_START_RE);
  const opRaw = (mOp?.[1] ?? "").toLowerCase();

  let op = null;
  if (opRaw.includes("déplacement") || opRaw.includes("deplacement")) op = "deplacement";
  else if (opRaw.includes("création") || opRaw.includes("creation")) op = "creation";
  else if (opRaw.includes("adaptation")) op = "adaptation";
  else if (opRaw.includes("mutation")) op = "mutation";

  const op2 = (op === "deplacement" && /\bet\s+adaptation\b/i.test(bloc)) ? "adaptation" : null;

  const mtp = bloc.match(POSTE_TYPE_APRES_RE);
  const typeApresRaw = mtp?.groups?.type ? mtp.groups.type.trim().toUpperCase() : null;
  const typeApresCodeFromRaw = typeApresRaw ? normTypePoste(typeApresRaw) : null;

  const pairs = buildTypePowerPairs(bloc);

  let typeAvantCode = null, typeAvantKva = null, typeApresCode = null, typeApresKva = null;

  if (pairs.length >= 2) {
    typeAvantCode = pairs[0].code; typeAvantKva = pairs[0].puissance_kva;
    typeApresCode = pairs[1].code; typeApresKva = pairs[1].puissance_kva;
  } else if (pairs.length === 1) {
    typeAvantCode = pairs[0].code; typeAvantKva = pairs[0].puissance_kva;
    typeApresKva = fallbackTypeApresPower(bloc);
    typeApresCode = typeApresCodeFromRaw;
  } else {
    [typeAvantCode, typeAvantKva] = fallbackTypeAvantPower(bloc);
    typeApresKva = fallbackTypeApresPower(bloc);
    typeApresCode = typeApresCodeFromRaw;
  }

  if (typeApresCode == null && typeApresCodeFromRaw != null) typeApresCode = typeApresCodeFromRaw;

  if (op == null && typeAvantCode == null && typeApresRaw == null && typeAvantKva == null && typeApresKva == null) return null;

  return {
    operation_principale: op,
    operation_secondaire: op2,
    type_avant: { code: typeAvantCode, puissance_kva: typeAvantKva },
    type_apres: { code: typeApresCode, raw: typeApresRaw, puissance_kva: typeApresKva },
  };
}

/* ============================================================
   PDL : extraction multiple par blocs RAC (affaires groupées)
============================================================ */

function splitLines(txt) {
  return (txt || "").split(/\r?\n/).map(x => x.trim());
}

function isNoiseLine(ln) {
  if (!ln) return true;
  const u = ln.toUpperCase().trim();
  if (!u) return true;
  if (u.startsWith("P=") || u.startsWith("P =")) return true;
  if (u.includes("LEGENDE")) return true;
  if (u.includes("TAN") || u.includes("PLATINE")) return true;
  return false;
}

function extractNomDossierFromBlock(block, rac) {
  const lines = splitLines(block);
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(rac)) { idx = i; break; }
  }
  if (idx < 0) return null;

  for (let j = idx + 1; j < Math.min(lines.length, idx + 8); j++) {
    const ln = lines[j].trim();
    if (isNoiseLine(ln)) continue;
    if (RAC_ONE_RE.test(ln)) continue;
    return ln;
  }
  return null;
}

function extractPProdFromBlock(block) {
  const m = (block || "").match(P_KVA_RE);
  if (!m) return null;
  const v = parseInt(m[1], 10);
  return Number.isFinite(v) ? v : null;
}

function extractPConsoFromBlock(block) {
  const m = (block || "").match(PCONSO_VAL_RE);
  if (!m) return null;
  const v = parseInt(m[1], 10);
  return Number.isFinite(v) ? v : null;
}

function extractPrmFromBlock(block) {
  const m = (block || "").match(PRM14_RE);
  return m ? m[0] : null;
}

function extractTypeRaccordementFromBlock(block) {
  const b = (block || "").toLowerCase();
  if (b.includes("départ direct") || b.includes("depart direct")) return "depart_direct";
  if (b.includes("dérivation") || b.includes("derivation")) return "derivation";
  return null;
}

function extractPdls(text) {
  if (!text) return [];

  const racMatches = Array.from(text.matchAll(RAC_RE)).map(m => ({
    pos: m.index ?? 0,
    rac: m[0],
  }));

  if (!racMatches.length) return [];

  const pdls = [];

  for (let i = 0; i < racMatches.length; i++) {
    const { pos, rac } = racMatches[i];
    const end = (i + 1 < racMatches.length) ? racMatches[i + 1].pos : text.length;
    const block = text.slice(pos, end);

    const mode = SURPLUS_RE.test(block) ? "vente_surplus" : "vente_totale";
    const nom = extractNomDossierFromBlock(block, rac);
    const pProd = extractPProdFromBlock(block);
    const typeR = extractTypeRaccordementFromBlock(block);

    const pdl = {
      mode,
      num_affaire: rac,
      nom_dossier: nom,
      p_prod_kva: pProd,
      type_raccordement: typeR,
    };

    if (mode === "vente_surplus") {
      pdl.prm = extractPrmFromBlock(block);
      pdl.p_conso_kva = extractPConsoFromBlock(block);
    }

    pdls.push(pdl);
  }

  return pdls;
}

