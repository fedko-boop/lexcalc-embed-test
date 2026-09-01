// LexCalc Import Engine — Pure invoice-import mapping module (no DOM, no I/O)
//
// Turns raw imported data into a review model the UI can display and the user
// can correct before the rows are pushed into the calculator. It is deliberately
// LIBRARY-AGNOSTIC: it never touches pdf.js, SheetJS, FileReader or the network.
// The DOM adapter in lexcalc-v2-29.html does the file reading / PDF-text /
// spreadsheet parsing and hands the results here as plain data:
//
//   - tabular source  → { kind:'table', name, headers:[...], rows:[[...],[...]] }
//   - text source     → { kind:'text',  name, text:'...' }   (e.g. PDF text layer)
//
// Output (buildReview): a review model with one row per candidate invoice, each
// field carrying a value + confidence (0..100) + flag (ok|review|error) + reason,
// plus a per-source column mapping (user-remappable) and a summary tally.
//
// Target fields mirror the manual saveInvoice() contract: ref, maturity, principal,
// regime, notes. Advanced stream/rate overrides are NOT imported — committed rows
// take the same defaults saveInvoice() applies. Validation rules are kept in sync
// with saveInvoice(): maturity required and < today, principal required and > 0,
// regime one of default|sk1|sk2|skc|cz.
const LexCalcImportEngine = (() => {

const IMPORT_ENGINE_VERSION = '1.0.0';

// Canonical target fields and which of them are strictly required (same as the
// manual form: a row cannot be committed without a valid maturity and principal).
const TARGET_FIELDS = ['ref', 'maturity', 'principal', 'regime', 'notes'];
const REQUIRED_FIELDS = ['maturity', 'principal'];
const REGIMES = ['default', 'sk1', 'sk2', 'skc', 'cz'];

// Confidence bands. A field at or above REVIEW_MIN is trusted (green); a valid
// value below it is amber ("review"); an invalid/missing required value is red.
const CONF_HIGH = 95;   // exact header/label match, cleanly parsed
const CONF_MED  = 75;   // partial/contained match
const CONF_LOW  = 55;   // fuzzy / positional guess
const REVIEW_MIN = 70;  // below this a present value is flagged for review

// Header synonyms per target field (lowercased, diacritics folded). Matched by
// exact-equality first, then substring containment. EN / SK / CZ vocabulary.
const HEADER_SYNONYMS = {
  ref:      ['ref', 'reference', 'invoice', 'invoice no', 'invoice number', 'invoice #',
             'inv no', 'faktura', 'cislo faktury', 'c. faktury', 'vs', 'variabilny symbol',
             'variabilny', 'doklad', 'cislo dokladu', 'number', 'no', 'title', 'nazov'],
  maturity: ['maturity', 'due', 'due date', 'duedate', 'date due', 'splatnost',
             'datum splatnosti', 'den splatnosti', 'termin splatnosti', 'splatne',
             'maturity date', 'datum splatnost'],
  principal:['principal', 'amount', 'amount due', 'sum', 'suma', 'istina', 'celkom',
             'spolu', 'total', 'castka', 'dlzna suma', 'dlh', 'value', 'hodnota',
             'suma s dph', 'k uhrade', 'na uhradu'],
  regime:   ['regime', 'rezim', 'mode', 'rezim uroku', 'interest regime', 'typ'],
  notes:    ['notes', 'note', 'poznamka', 'popis', 'comment', 'comments', 'description'],
};

// ---- text normalization ------------------------------------------------------
// Fold diacritics and lowercase so "Splatnosť" == "splatnost". Deterministic.
function norm(s) {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim();
}

// ---- number parsing ----------------------------------------------------------
// Locale-tolerant money parser. Handles NBSP/space thousands, and both ","/"."
// decimals: when both separators appear, the LAST one is the decimal point and
// the other is a thousands separator; a lone comma is treated as the decimal
// separator (SK/CZ convention). Returns null when no number is present.
function parseAmount(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return isFinite(raw) ? raw : null;
  let s = String(raw).trim();
  if (s === '') return null;
  // Negative if wrapped in accounting parentheses or carrying a minus sign.
  const neg = /^\(.*\)$/.test(s) || s.indexOf('-') !== -1;
  // keep digits and separators only
  s = s.replace(/[^\d,.]/g, '');
  if (s === '' || s === '.' || s === ',') return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma !== -1 && lastDot !== -1) {
    if (lastComma > lastDot) { s = s.replace(/\./g, '').replace(',', '.'); }
    else { s = s.replace(/,/g, ''); }
  } else if (lastComma !== -1) {
    // lone comma → decimal separator
    s = s.replace(/\./g, '').replace(',', '.');
  }
  const n = parseFloat(s);
  if (isNaN(n)) return null;
  return neg && n > 0 ? -n : n;
}

// ---- date parsing ------------------------------------------------------------
// Accepts a Date, an Excel date serial (SheetJS numeric), or a string in ISO
// (YYYY-MM-DD), D.M.YYYY, D/M/YYYY or D-M-YYYY form. Returns an ISO YYYY-MM-DD
// string or null. Day/month order assumes little-endian (SK/CZ/EU) for the
// dotted/slashed forms; ISO stays big-endian.
function pad2(n) { return String(n).padStart(2, '0'); }
function parseDateISO(raw) {
  if (raw == null || raw === '') return null;
  if (raw instanceof Date && !isNaN(raw)) {
    return raw.getFullYear() + '-' + pad2(raw.getMonth() + 1) + '-' + pad2(raw.getDate());
  }
  if (typeof raw === 'number' && isFinite(raw)) {
    // Excel serial date (1900 date system): day 1 = 1899-12-31, with the
    // well-known 1900 leap-year bug offset. Only treat plausible serials as dates.
    if (raw > 20000 && raw < 80000) {
      const ms = Math.round((raw - 25569) * 86400 * 1000); // 25569 = days 1899-12-30→1970-01-01
      const d = new Date(ms);
      if (!isNaN(d)) return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
    }
    return null;
  }
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return m[1] + '-' + pad2(m[2]) + '-' + pad2(m[3]);
  m = s.match(/^(\d{1,2})[.\/\-]\s*(\d{1,2})[.\/\-]\s*(\d{4})$/);
  if (m) return m[3] + '-' + pad2(m[2]) + '-' + pad2(m[1]);
  return null;
}

function todayISO(today) {
  if (today) return String(today).slice(0, 10);
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

// ============================================================
// COLUMN MAPPING (tabular sources)
// ============================================================
// Given header cells, guess which column feeds each target field. Returns
// { <field>: { col: index|null, confidence } }. Exact synonym → CONF_HIGH,
// substring containment → CONF_MED. Each column is claimed by at most one field.
function detectColumnMapping(headers) {
  const normHeaders = (headers || []).map(norm);
  const mapping = {};
  const taken = {};
  TARGET_FIELDS.forEach(field => {
    const syns = HEADER_SYNONYMS[field];
    let best = { col: null, confidence: 0 };
    normHeaders.forEach((h, i) => {
      if (!h || taken[i]) return;
      let conf = 0;
      if (syns.indexOf(h) !== -1) conf = CONF_HIGH;
      else if (syns.some(sy => h === sy)) conf = CONF_HIGH;
      else if (syns.some(sy => sy.length >= 3 && (h.indexOf(sy) !== -1 || sy.indexOf(h) !== -1))) conf = CONF_MED;
      if (conf > best.confidence) best = { col: i, confidence: conf };
    });
    if (best.col !== null) taken[best.col] = true;
    mapping[field] = best;
  });
  return mapping;
}

// Optional per-invoice creditor/debtor IČO columns (spreadsheet import). Not part
// of the editable TARGET_FIELDS — detected separately so tabular rows can feed the
// same party guard as PDF rows. EN/SK/CZ header vocabulary.
const PARTY_HEADER_SYNONYMS = {
  creditorIco: ['creditor ico', 'creditor', 'ico dodavatela', 'dodavatel ico', 'ico dodavatel', 'ico veritela', 'veritel ico', 'ico veritel', 'supplier ico', 'supplier vat', 'creditor vat', 'creditor id'],
  debtorIco:   ['debtor ico', 'debtor', 'ico odberatela', 'odberatel ico', 'ico odberatel', 'ico dlznika', 'dlznik ico', 'ico dlznik', 'customer ico', 'customer vat', 'debtor vat', 'debtor id'],
};
function detectPartyColumns(headers) {
  const normHeaders = (headers || []).map(norm);
  const out = { creditorIco: null, debtorIco: null };
  const taken = {};
  ['creditorIco', 'debtorIco'].forEach(key => {
    const syns = PARTY_HEADER_SYNONYMS[key];
    let best = null, bestConf = 0;
    normHeaders.forEach((h, i) => {
      if (!h || taken[i]) return;
      let conf = 0;
      if (syns.indexOf(h) !== -1) conf = CONF_HIGH;
      else if (syns.some(sy => sy.length >= 4 && (h.indexOf(sy) !== -1 || sy.indexOf(h) !== -1))) conf = CONF_MED;
      if (conf > bestConf) { bestConf = conf; best = i; }
    });
    if (best !== null) { taken[best] = true; out[key] = best; }
  });
  return out;
}
// Read an IČO-like value from a cell (8 digits, tolerating spaces/labels).
function cleanIco(raw) {
  if (raw == null) return '';
  const m = String(raw).replace(/\s/g, '').match(/\d{8}/);
  return m ? m[0] : '';
}

// ============================================================
// FIELD BUILDING + VALIDATION
// ============================================================
// Produce a { value, confidence, flag, reason } cell for one target field from a
// raw value already located by the mapping. baseConfidence is how sure we are the
// raw value belongs to this field (header/label match strength).
function buildField(field, rawValue, baseConfidence, ctx) {
  const today = ctx.today;
  const present = rawValue != null && String(rawValue).trim() !== '';

  if (field === 'principal') {
    if (!present) return cell(null, 0, 'error', 'missing');
    const n = parseAmount(rawValue);
    if (n == null) return cell(String(rawValue), 0, 'error', 'not a number');
    if (n <= 0) return cell(n, Math.min(baseConfidence, CONF_LOW), 'error', 'must be > 0');
    return cell(n, baseConfidence, baseConfidence < REVIEW_MIN ? 'review' : 'ok', null);
  }

  if (field === 'maturity') {
    if (!present) return cell(null, 0, 'error', 'missing');
    const iso = parseDateISO(rawValue);
    if (!iso) return cell(String(rawValue), 0, 'error', 'unrecognized date');
    // A not-yet-due maturity is a valid invoice (manual entry allows it; the
    // engine simply accrues no interest until it matures) — surface it for a
    // look, but never block it.
    if (iso >= today) return cell(iso, Math.min(baseConfidence, CONF_LOW), 'review', 'not yet due — no interest yet');
    return cell(iso, baseConfidence, baseConfidence < REVIEW_MIN ? 'review' : 'ok', null);
  }

  if (field === 'regime') {
    if (!present) return cell('default', CONF_LOW, 'review', 'defaulted — confirm');
    const v = norm(rawValue);
    const match = REGIMES.find(r => r === v);
    if (match) return cell(match, baseConfidence, baseConfidence < REVIEW_MIN ? 'review' : 'ok', null);
    // tolerate a few spellings
    const alias = { 'sk civil': 'skc', 'civil': 'skc', 'default': 'default', 'cz': 'cz' }[v];
    if (alias) return cell(alias, CONF_MED, 'review', 'mapped from "' + rawValue + '"');
    return cell('default', CONF_LOW, 'review', 'unknown regime "' + rawValue + '" → default');
  }

  if (field === 'ref') {
    if (!present) return cell('', CONF_MED, 'ok', 'will auto-number');
    return cell(String(rawValue).trim(), baseConfidence, baseConfidence < REVIEW_MIN ? 'review' : 'ok', null);
  }

  // notes (free, optional)
  if (!present) return cell('', 100, 'ok', null);
  return cell(String(rawValue).trim(), baseConfidence, 'ok', null);
}

function cell(value, confidence, flag, reason) {
  return { value: value, confidence: Math.round(confidence), flag: flag, reason: reason || null };
}

const FLAG_RANK = { ok: 0, review: 1, error: 2 };
function worstFlag(perField) {
  let worst = 'ok';
  TARGET_FIELDS.forEach(f => {
    if (perField[f] && FLAG_RANK[perField[f].flag] > FLAG_RANK[worst]) worst = perField[f].flag;
  });
  return worst;
}

// Re-validate a single edited value in place (used by the UI when the user fixes a
// cell). Confidence is set to CONF_HIGH because a human typed/confirmed it.
function revalidateField(field, rawValue, options) {
  const ctx = { today: todayISO(options && options.today) };
  const c = buildField(field, rawValue, CONF_HIGH, ctx);
  // a human edit that is still invalid keeps its error flag but full "user" confidence intent
  return c;
}

// ============================================================
// TABULAR SOURCE → REVIEW ROWS
// ============================================================
function mapTableRows(source, mapping, options) {
  const ctx = { today: todayISO(options && options.today) };
  const rows = source.rows || [];
  const party = detectPartyColumns(source.headers || []);
  return rows.map((row, ri) => {
    const perField = {};
    TARGET_FIELDS.forEach(field => {
      const map = mapping[field] || { col: null, confidence: 0 };
      const raw = (map.col != null) ? row[map.col] : null;
      const base = map.col != null ? Math.max(map.confidence, CONF_LOW) : CONF_LOW;
      perField[field] = buildField(field, raw, map.col != null ? base : CONF_LOW, ctx);
      if (map.col == null && (field === 'maturity' || field === 'principal')) {
        perField[field] = cell(null, 0, 'error', 'no column mapped');
      }
    });
    const out = finalizeRow(source, ri, perField);
    // optional per-invoice party IČOs from spreadsheet columns → same shape as PDF rows
    const credIco = party.creditorIco != null ? cleanIco(row[party.creditorIco]) : '';
    const debIco = party.debtorIco != null ? cleanIco(row[party.debtorIco]) : '';
    if (credIco || debIco) {
      out.parties = { creditor: credIco ? { name: '', ico: credIco, dic: '', icdph: '', address: '' } : null,
                      debtor: debIco ? { name: '', ico: debIco, dic: '', icdph: '', address: '' } : null };
      out.icos = [credIco, debIco].filter(Boolean);
    }
    return out;
  });
}

// ============================================================
// TEXT SOURCE (PDF text layer) → single review row
// ============================================================
// Real invoices do not lay a label next to its value: pdf.js emits a table's
// value column separately from its label column (e.g. the three header dates come
// out as a block, their labels "Dátum vystavenia… / Splatnosť:" much later), and
// the text carries diacritics. So extraction is layout-tolerant:
//   (a) match against an accent-folded, whitespace-collapsed copy (`flat`) so
//       "Splatnosť"/"Celkom k úhrade"/"Faktúra č." are found;
//   (b) prefer a value adjacent to its label (medium confidence);
//   (c) fall back to heuristics — the LATEST date is the due date (due ≥ issue);
//       the amount after an amount-due label, else the LAST money amount (invoice
//       totals sit at the bottom) is the principal — at low confidence, so the row
//       is flagged "review" for the user to confirm rather than trusted blindly.
// The raw text is attached to the row (`extractedText`) so the UI can show exactly
// what was read. A near-empty text layer means a scanned/image PDF.

function isEffectivelyEmptyText(text) {
  return norm(text).replace(/[^a-z0-9]/g, '').length < 8;
}

// Accent-folded, whitespace-collapsed copy for label searching. Digits, dates and
// money are ASCII so they read straight out of this copy.
function flattenText(text) {
  return norm(text).replace(/\u00ad/g, '').replace(/\s+/g, ' ').trim();
}

// Date grammar: ISO (yyyy-m-d) or little-endian d.m.yyyy / d/m/yyyy.
const DATE_ANY = '(\\d{4})-(\\d{1,2})-(\\d{1,2})|(\\d{1,2})[.\\/](\\d{1,2})[.\\/](\\d{4})';
function matchToIso(m) {
  if (m[1]) return m[1] + '-' + pad2(m[2]) + '-' + pad2(m[3]);
  return m[6] + '-' + pad2(m[5]) + '-' + pad2(m[4]);
}
function findDates(flat) {
  const re = new RegExp(DATE_ANY, 'g');
  const out = []; let m;
  while ((m = re.exec(flat)) !== null) {
    const iso = matchToIso(m);
    const y = parseInt(iso.slice(0, 4), 10);
    if (!isNaN(new Date(iso).getTime()) && y >= 1990 && y <= 2100) out.push(iso);
  }
  return out;
}
// Money with 2 decimals, optional space/dot thousands separators.
const AMOUNT_ANY = '\\d{1,3}(?:[ .]\\d{3})*[.,]\\d{2}|\\d+[.,]\\d{2}';

// Dates with their positions in `flat`, for label↔value pairing.
function findDatePositions(flat) {
  const re = new RegExp(DATE_ANY, 'g');
  const out = []; let m;
  while ((m = re.exec(flat)) !== null) {
    const iso = matchToIso(m);
    const y = parseInt(iso.slice(0, 4), 10);
    if (!isNaN(new Date(iso).getTime()) && y >= 1990 && y <= 2100) {
      out.push({ iso: iso, index: m.index, end: m.index + m[0].length });
    }
  }
  return out;
}
// Date-role labels (SK/CZ/EN). `due` is the one we want; issue/taxable are here so
// a block of labels can be paired to a block of dates by position.
const DATE_LABELS = [
  { role: 'due',     re: 'splatnost|splatne\\s*do|termin\\s*splatnosti|due\\s*date|date\\s*due|maturity|payment\\s*due' },
  { role: 'issue',   re: 'datum\\s*vystaven|date\\s*of\\s*issue|invoice\\s*date|issue\\s*date' },
  { role: 'taxable', re: 'uskutecneni|zdanitelneho\\s*plneni|zdan\\.?\\s*plneni|tax\\s*point|supply\\s*date' },
];

// group dates into contiguous clusters (a "block" = dates ≤40 chars apart)
function clusterDates(dates) {
  const clusters = []; let cur = [];
  dates.forEach(d => {
    if (cur.length && d.index - cur[cur.length - 1].end > 40) { clusters.push(cur); cur = []; }
    cur.push(d);
  });
  if (cur.length) clusters.push(cur);
  return clusters;
}
function gapBetween(a1, a2, b1, b2) {
  if (a2 < b1) return b1 - a2;
  if (b2 < a1) return a1 - b2;
  return 0;
}

function extractRefFromText(flat) {
  // value AFTER a label: "faktúra č.  2025001" (require the space so glued
  // line-item refs "(faktúra č.12501217)" don't win); "číslo dokladu : 140104090".
  let m = flat.match(/faktura\s*c\.?\s+([0-9][0-9\/]{2,})/);
  if (m) return m[1];
  m = flat.match(/(?:cislo\s*dokladu|cislo\s*faktury|variabiln[yi]\s*symbol|var\.?\s*sym\.?|invoice\s*(?:no|number|#))\s*[:#.]?\s+([0-9][0-9\/]{3,})/);
  if (m) return m[1];
  // value BEFORE the label: "140104090 Var.sym."
  m = flat.match(/([0-9][0-9\/]{3,})\s+(?:var\.?\s*sym|variabiln[yi]\s*symbol)/);
  if (m) return m[1];
  return null;
}

function extractDueFromText(flat) {
  const dates = findDatePositions(flat);
  if (!dates.length) return null;
  const labels = [];
  DATE_LABELS.forEach(dl => { const m = new RegExp(dl.re).exec(flat); if (m) labels.push({ role: dl.role, index: m.index }); });
  labels.sort((a, b) => a.index - b.index);
  const dueLabel = labels.find(l => l.role === 'due');

  // Positional pairing: pick the date cluster nearest the label block and pair by
  // reading order (date[i] ↔ i-th label). Works whether dates precede or follow
  // labels, and ignores far-away dates (e.g. travel dates) — only the nearest
  // cluster is used. Handles "due = first" (CZ) and "due = last" (SK) alike.
  if (labels.length >= 2 && dueLabel) {
    const lStart = labels[0].index, lEnd = labels[labels.length - 1].index;
    let best = null, bestDist = Infinity;
    clusterDates(dates).forEach(c => {
      const d = gapBetween(c[0].index, c[c.length - 1].end, lStart, lEnd);
      if (d < bestDist) { bestDist = d; best = c; }
    });
    const dueIdx = labels.findIndex(l => l.role === 'due');
    if (best && bestDist < 400 && dueIdx < best.length) return { iso: best[dueIdx].iso, conf: CONF_LOW };
  }
  if (dueLabel) {
    const win = flat.slice(dueLabel.index, dueLabel.index + 60);       // adjacent date after the label
    const dm = win.match(new RegExp(DATE_ANY));
    if (dm) return { iso: matchToIso(dm), conf: CONF_MED };
    let near = null, nd = Infinity;                                    // else nearest date to the label
    dates.forEach(x => { const d = Math.abs(x.index - dueLabel.index); if (d < nd) { nd = d; near = x; } });
    if (near) return { iso: near.iso, conf: CONF_LOW };
  }
  if (dates.length === 1) return { iso: dates[0].iso, conf: CONF_LOW };
  return null;
}

function extractPrincipalFromText(flat) {
  const label = /(celkom\s*k\s*uhrade|k\s*uhrade|suma\s*na\s*uhradu|na\s*uhradu|k\s*platbe|amount\s*due|total\s*due|balance\s*due|total\s*payable|amount\s*payable)/;
  const m = label.exec(flat);
  if (m) {
    const after = flat.slice(m.index + m[0].length, m.index + m[0].length + 40);
    const a = after.match(new RegExp(AMOUNT_ANY));
    if (a) return { value: parseAmount(a[0]), conf: CONF_MED };        // amount after the label
    const before = flat.slice(Math.max(0, m.index - 30), m.index);     // or before it ("Kč 7 222,00 K úhradě celkem")
    const bs = before.match(new RegExp(AMOUNT_ANY, 'g'));
    if (bs && bs.length) return { value: parseAmount(bs[bs.length - 1]), conf: CONF_MED };
  }
  const all = flat.match(new RegExp(AMOUNT_ANY, 'g'));                 // fallback: last amount (totals are last)
  if (all && all.length) return { value: parseAmount(all[all.length - 1]), conf: CONF_LOW };
  return null;
}

// Regime: infer 'cz' from Czech currency/markers (Kč, daňový doklad, CZ tax id).
// Slovak commercial-vs-civil cannot be told from an invoice, so leave 'default'.
function extractRegimeFromText(flat) {
  if (/\bkc\b|\bczk\b|danovy\s*doklad|zakona\s*o\s*dph|\bcz\d{8}\b/.test(flat)) return 'cz';
  return null;
}

// Company registration numbers (IČO — 8 digits in SK/CZ) present in the invoice.
// This is the reliable key for the multi-party guard: two parties' names/DIČ are
// interleaved and hard to attribute, but the set of IČOs in each invoice is not.
// Returns distinct IČOs in first-seen order. Excludes obvious non-IČO 8-digit runs
// (bank account fragments) by requiring an IČO/ICO context or a standalone token.
function findCompanyIcos(flat) {
  return findIcoPositions(flat).map(x => x.v).filter((v, i, a) => a.indexOf(v) === i);
}
function findIcoPositions(flat) {
  const out = []; let m;
  const re = /\bico\s*[:#]?\s*(\d{8})\b/g;
  while ((m = re.exec(flat)) !== null) out.push({ v: m[1], i: m.index });
  const re2 = /\bcz(\d{8})\b/g;
  while ((m = re2.exec(flat)) !== null) out.push({ v: m[1], i: m.index });
  return out;
}

// Best-effort structured parties for the case cards. Supplier (Dodávateľ) → the
// creditor; customer (Odberateľ) → the debtor. Each id (IČO / DIČ / IČ DPH) is
// attributed to whichever party label it sits closest to in the text; the name is
// the nearest company-like line to that label in the ORIGINAL text. This is
// heuristic (the two blocks are interleaved by PDF extraction), so the fields land
// in the card as suggestions for the user to confirm — never trusted blindly.
// Company-name markers, tightened to avoid false hits inside ordinary words
// (e.g. "s.p." must carry its dots so it does not match "sp" in "splatnosti").
const NAME_SUFFIX = /(\bs\.\s?r\.\s?o\b|\ba\.\s?s\b|\bspol\.|\bk\.\s?s\b|\bv\.\s?o\.\s?s\b|z(?:vaz|väz)\b|zdru[zž]enie\b|\bklub\b|s\.\s?p\.|o\.\s?z\.)/i;
const OTHER_LABEL = /dodavatel|odberatel|supplier|customer|predavajuci|kupujuci|objednavatel/i;
function extractParties(flat, rawText) {
  const dod = flat.search(/dodavatel|supplier|predavajuci|zhotovitel|veritel/);
  const odb = flat.search(/odberatel|customer|kupujuci|objednavatel|dlznik/);
  const role = pos => {
    const dd = dod >= 0 ? Math.abs(pos - dod) : 1e9, oo = odb >= 0 ? Math.abs(pos - odb) : 1e9;
    return dd <= oo ? 'creditor' : 'debtor';
  };
  const creditor = { name:'', address:'', ico:'', dic:'', icdph:'' };
  const debtor   = { name:'', address:'', ico:'', dic:'', icdph:'' };
  const pick = r => (r === 'creditor' ? creditor : debtor);
  // IČ DPH (has country prefix) — assign before DIČ so the prefixed form wins
  let m;
  const reVat = /\bic\s*dph\s*[:#]?\s*((?:sk|cz)\d{9,10})\b/g;
  while ((m = reVat.exec(flat)) !== null) { const o = pick(role(m.index)); if (!o.icdph) o.icdph = m[1].toUpperCase(); }
  const reDic = /\bdic\s*[:#]?\s*((?:sk|cz)?\d{9,10})\b/g;
  while ((m = reDic.exec(flat)) !== null) { const o = pick(role(m.index)); if (!o.dic) o.dic = m[1].toUpperCase(); }
  // IČO assignment. With two distinct IČOs and both labels present, PAIR them:
  // the one nearest Dodávateľ → creditor, the one nearest Odberateľ → debtor, kept
  // distinct — so both roles fill even when the two are close together in the text.
  // Otherwise assign each to its nearer label individually.
  const distinct = [];
  findIcoPositions(flat).forEach(x => { if (!distinct.some(d => d.v === x.v)) distinct.push(x); });
  if (distinct.length >= 2 && dod >= 0 && odb >= 0) {
    const nearest = pos => distinct.slice().sort((a, b) => Math.abs(a.i - pos) - Math.abs(b.i - pos));
    creditor.ico = nearest(dod)[0].v;
    const forDeb = nearest(odb);
    debtor.ico = forDeb[0].v !== creditor.ico ? forDeb[0].v : (forDeb[1] ? forDeb[1].v : '');
  } else {
    distinct.forEach(x => { const o = pick(role(x.i)); if (!o.ico) o.ico = x.v; });
  }
  // names: nearest distinct company-like line to each label in the ORIGINAL text.
  // If both labels resolve to the same line (a two-column "Dodávateľ  Odberateľ"
  // header), name attribution is unreliable — leave names blank rather than copy.
  if (rawText) {
    const lines = rawText.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const nDod = lines.findIndex(l => /dodavatel|supplier|predavajuci/i.test(norm(l)));
    const nOdb = lines.findIndex(l => /odberatel|customer|kupujuci|objednavatel/i.test(norm(l)));
    const used = {};
    // A company name is accepted only if it carries a company marker and is not
    // itself a party label — so we get a real name or nothing, never garbage.
    const clean = s => (s && NAME_SUFFIX.test(s) && !OTHER_LABEL.test(norm(s)) && s.length < 60) ? s : '';
    const nameFor = (idx, labelRe) => {
      if (idx < 0) return '';
      const sameLine = clean((lines[idx].split(new RegExp(labelRe, 'i'))[1] || '').replace(/^[:\s.\-]+/, '').trim());
      if (sameLine) return sameLine;                       // "Dodávateľ: ACME s.r.o."
      for (let d = 1; d < 5; d++) for (const j of [idx + d, idx - d]) {   // else nearest distinct company line
        if (j >= 0 && j < lines.length && !used[j] && clean(lines[j])) { used[j] = 1; return lines[j]; }
      }
      return '';
    };
    if (nDod >= 0) creditor.name = nameFor(nDod, 'dodavatel|supplier|predavajuci');
    if (nOdb >= 0) debtor.name = nameFor(nOdb, 'odberatel|customer|kupujuci|objednavatel');
  }
  const any = p => p.name || p.ico || p.dic || p.icdph;
  return { creditor: any(creditor) ? creditor : null, debtor: any(debtor) ? debtor : null };
}

// Possible-duplicate detection. Two invoices are flagged as likely the same when
// they share maturity AND principal (to the cent) — the strong signal in practice
// (e.g. the same invoice imported once from PDF and again in a spreadsheet). Refs
// need not match (PDF may read "02326" where the sheet has "2326"). Returns groups
// of indices into the given array; each group has ≥2 members. Warn, never block.
function findDuplicates(invoices) {
  const groups = {};
  (invoices || []).forEach((inv, idx) => {
    if (!inv || inv.enabled === false) return;
    if (!inv.maturity || !(Number(inv.principal) > 0)) return;
    const key = inv.maturity + '|' + Math.round(Number(inv.principal) * 100);
    (groups[key] = groups[key] || []).push(idx);
  });
  return Object.keys(groups).map(k => groups[k]).filter(g => g.length > 1);
}
function normRef(r) { return String(r == null ? '' : r).replace(/[^a-z0-9]/gi, '').replace(/^0+/, '').toLowerCase(); }

function mapTextSource(source, options) {
  const ctx = { today: todayISO(options && options.today) };
  const text = source.text || '';
  const perField = {};
  if (isEffectivelyEmptyText(text)) {
    TARGET_FIELDS.forEach(f => {
      perField[f] = REQUIRED_FIELDS.indexOf(f) !== -1
        ? cell(null, 0, 'error', 'no text layer — scanned PDF')
        : buildField(f, null, CONF_LOW, ctx);
    });
    const row = finalizeRow(source, 0, perField);
    row.scanned = true;
    row.extractedText = text;
    row.issues.unshift('No extractable text (scanned/image PDF) — enter manually or await SharePoint recognition');
    return [row];
  }

  const flat = flattenText(text);

  const ref = extractRefFromText(flat);
  perField.ref = buildField('ref', ref, ref ? CONF_MED : CONF_LOW, ctx);

  const due = extractDueFromText(flat);
  perField.maturity = due
    ? buildField('maturity', due.iso, due.conf, ctx)
    : cell(null, 0, 'error', 'due date not found — enter manually');

  const prin = extractPrincipalFromText(flat);
  perField.principal = prin
    ? buildField('principal', prin.value, prin.conf, ctx)
    : cell(null, 0, 'error', 'amount not found — enter manually');

  perField.regime = buildField('regime', extractRegimeFromText(flat), CONF_LOW, ctx);  // 'cz' if Czech, else default
  perField.notes = buildField('notes', null, 100, ctx);

  const row = finalizeRow(source, 0, perField);
  row.extractedText = text;
  row.icos = findCompanyIcos(flat);   // company IDs for the multi-party guard
  row.parties = extractParties(flat, text);   // best-effort creditor/debtor for the cards
  return [row];
}

// ---- assemble one review row -------------------------------------------------
function finalizeRow(source, index, perField) {
  const fields = {};
  TARGET_FIELDS.forEach(f => { fields[f] = perField[f].value; });
  const issues = [];
  TARGET_FIELDS.forEach(f => {
    if (perField[f].flag === 'error') issues.push(f + ': ' + (perField[f].reason || 'invalid'));
  });
  return {
    source: source.name || 'import',
    sourceKind: source.kind,
    index: index,
    fields: fields,
    perField: perField,
    rowStatus: worstFlag(perField),
    accepted: worstFlag(perField) !== 'error', // error rows start unaccepted until fixed
    scanned: false,
    issues: issues,
  };
}

// ============================================================
// ORCHESTRATION
// ============================================================
// inputs: array of source descriptors ({kind:'table',...} | {kind:'text',...}).
// options: { today?, mappings? }  mappings[i] overrides the auto-detected column
// mapping for tabular source i (user remap).
function buildReview(inputs, options) {
  options = options || {};
  const sources = [];
  let rows = [];
  (inputs || []).forEach((src, si) => {
    if (src.kind === 'table') {
      const mapping = (options.mappings && options.mappings[si]) || detectColumnMapping(src.headers || []);
      sources.push({ index: si, name: src.name, kind: 'table', headers: src.headers || [], mapping: mapping });
      rows = rows.concat(mapTableRows(src, mapping, options).map(r => { r.sourceIndex = si; return r; }));
    } else if (src.kind === 'text') {
      sources.push({ index: si, name: src.name, kind: 'text' });
      rows = rows.concat(mapTextSource(src, options).map(r => { r.sourceIndex = si; return r; }));
    }
  });
  return { rows: rows, sources: sources, summary: summarize(rows), engineVersion: IMPORT_ENGINE_VERSION };
}

function summarize(rows) {
  const s = { total: rows.length, ready: 0, review: 0, error: 0, scanned: 0 };
  rows.forEach(r => {
    if (r.scanned) s.scanned++;
    if (r.rowStatus === 'error') s.error++;
    else if (r.rowStatus === 'review') s.review++;
    else s.ready++;
  });
  return s;
}

// Convert accepted, non-error review rows into the invoice object shape the UI
// commits. The UI still assigns id/enabled and calls calculate(); this just
// yields the imported field values (ref left blank → UI auto-numbers).
function toInvoiceSeeds(review) {
  return (review.rows || [])
    .filter(r => r.accepted && r.rowStatus !== 'error')
    .map(r => ({
      ref: r.fields.ref || '',
      maturity: r.fields.maturity,
      principal: r.fields.principal,
      regime: r.fields.regime || 'default',
      notes: r.fields.notes || '',
      srcIcos: r.icos || [],   // company IDs carried onto the invoice for the guard
      creditorIco: (r.parties && r.parties.creditor && r.parties.creditor.ico) || '',
      debtorIco:   (r.parties && r.parties.debtor && r.parties.debtor.ico) || '',
    }));
}

// Multi-party guard. Given a list of invoices each carrying `srcIcos` (company
// IDs found in the source PDF) and an optional known creditor IČO, decide whether
// the batch spans more than one debtor (or otherwise mixes parties). Returns
// { ok, debtors:[...], creditorIco, reason } — heuristic, IČO-based:
//   - creditorIco = the given one, else the single IČO common to every invoice
//     that has IČOs (the shared party across all invoices is the creditor);
//   - each invoice's debtor IČOs = its IČOs minus the creditor;
//   - >1 distinct debtor IČO across the batch → not ok (different debtors).
function partyGuard(invoicesWithIcos, knownCreditorIco) {
  const withIcos = (invoicesWithIcos || []).map(x => (x.srcIcos || []).filter(Boolean)).filter(a => a.length);
  if (withIcos.length < 1) return { ok: true, debtors: [], creditorIco: knownCreditorIco || null, reason: null };
  let creditorIco = knownCreditorIco || null;
  if (!creditorIco) {
    // IČOs common to every icos-bearing invoice
    let common = withIcos[0].slice();
    withIcos.slice(1).forEach(a => { common = common.filter(v => a.indexOf(v) !== -1); });
    if (common.length === 1) creditorIco = common[0];
    // if 0 or >1 common, we can't name the creditor confidently — fall through
  }
  const debtors = [];
  withIcos.forEach(a => {
    const d = a.filter(v => v !== creditorIco);
    // when creditor unknown, treat the whole set as candidate parties
    (creditorIco ? d : a).forEach(v => { if (debtors.indexOf(v) === -1) debtors.push(v); });
  });
  // With a known/derived creditor, >1 remaining party = different debtors.
  // Without one, disjoint invoices (no shared company at all) also means mixed.
  const ok = creditorIco ? (debtors.length <= 1) : hasCommonAcross(withIcos);
  return { ok: ok, debtors: debtors, creditorIco: creditorIco || null,
           reason: ok ? null : (creditorIco ? 'multiple-debtors' : 'no-shared-party') };
}
function hasCommonAcross(sets) {
  if (sets.length < 2) return true;
  let common = sets[0].slice();
  sets.slice(1).forEach(a => { common = common.filter(v => a.indexOf(v) !== -1); });
  return common.length > 0;
}

// ============================================================
// IIFE EXPORT
// ============================================================
return {
  IMPORT_ENGINE_VERSION,
  TARGET_FIELDS, REQUIRED_FIELDS, REGIMES,
  buildReview, detectColumnMapping, mapTableRows, mapTextSource,
  buildField, revalidateField, finalizeRow, worstFlag,
  toInvoiceSeeds, summarize, partyGuard, findCompanyIcos, extractParties,
  findDuplicates, normRef,
  parseAmount, parseDateISO, todayISO,
};

})();

// Universal export: CommonJS (Node / Azure Functions / tests) when available; the
// browser/SPFx global `LexCalcImportEngine` is unaffected.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = LexCalcImportEngine;
}
