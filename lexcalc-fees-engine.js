// LexCalc Fees Engine — Pure calculation module (no DOM, no I/O, no date-now reads)
// Two separate legal bases under one roof (per ROADMAP §2):
//
//   calcAttorneyFee()  — odmena advokáta / odměna advokáta
//       SK: vyhláška 655/2004 Z. z. (§ 10 — tarifná odmena za úkon)
//       CZ: vyhláška 177/1996 Sb.   (§ 7  — mimosmluvní odměna za úkon)
//
//   calcCourtFee()     — súdny poplatok / soudní poplatek
//       SK: zákon č. 71/1992 Zb.   (sadzobník, položka 1 — návrh, peňažné plnenie)
//       CZ: zákon č. 549/1991 Sb.  (sazebník, položka 1 — peněžité plnění)
//
// The two functions share band-lookup / rounding / currency helpers in this one
// file but are otherwise independent (separate legal bases).
//
// SCOPE (per ROADMAP "Deferred"): only the BASIC MONETARY scenario is built —
// i.e. the fee/poplatok is computed from a monetary tariff value (tarifná
// hodnota / cena predmetu konania), defaulting to the claim principal. The
// architecture carries a `caseType` selector so non-monetary / criminal /
// constitutional / no-value regimes can be added later; those currently emit a
// "not implemented" warning rather than guessing. Manual override of the final
// amount is always available.
const LexCalcFeesEngine = (() => {

const ENGINE_VERSION = '1.0.0';

// ============================================================
// SHARED HELPERS
// ============================================================

function num(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

function pushUnique(arr, v) { if (arr.indexOf(v) === -1) arr.push(v); }

// "za každých aj začatých X" / "za každých započatých X" — number of started
// units of size `unit` in `over`, never below zero.
function startedUnits(over, unit) {
  if (over <= 0) return 0;
  return Math.ceil(over / unit);
}

// Round to whole eurocents, half up (SK súdny poplatok / tariff convention).
function roundCents(v) {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

// Round up to whole crowns (CZ soudní poplatek convention).
function ceilCrown(v) {
  return Math.ceil(v - 1e-9);
}

function defaultCurrency(jur) { return jur === 'CZ' ? 'CZK' : 'EUR'; }
function defaultVatRate(jur) { return jur === 'CZ' ? 0.21 : 0.23; } // CZ 21 %; SK 23 % od 1.1.2025

// ============================================================
// ATTORNEY-FEE BAND TABLES (base tariff per ONE úkon, from tariff value)
// ============================================================

// SK vyhláška 655/2004 Z. z. § 10 ods. 1 — základná sadzba tarifnej odmeny za
// jeden úkon právnej služby z tarifnej hodnoty (eur).
function skAttorneyPerAct(T) {
  if (T <= 165.97)   return 16.60;
  if (T <= 663.88)   return 16.60  + startedUnits(T - 165.97,   33.19)    * 1.66;
  if (T <= 6638.78)  return 41.49  + startedUnits(T - 663.88,   331.94)   * 9.96;
  if (T <= 33193.92) return 220.74 + startedUnits(T - 6638.78,  1659.70)  * 16.60;
  return                    486.29 + startedUnits(T - 33193.92, 3319.39)  * 6.64;
}

// CZ vyhláška 177/1996 Sb. § 7 — mimosmluvní odměna za jeden úkon právní služby
// z tarifní hodnoty (Kč).
function czAttorneyPerAct(H) {
  if (H <= 500)      return 300;
  if (H <= 1000)     return 500;
  if (H <= 5000)     return 1000;
  if (H <= 10000)    return 1500;
  if (H <= 200000)   return 1500  + startedUnits(H - 10000,   1000)   * 40;
  if (H <= 10000000) return 9100  + startedUnits(H - 200000,  10000)  * 40;
  return                    48300 + startedUnits(H - 10000000, 100000) * 40;
}

// CZ § 13 odst. 4 — paušální náhrada hotových výdajů per úkon (stable).
const CZ_FLAT_PER_ACT = 300;

// SK výpočtový základ (€) per calendar year — § 1 ods. 3 vyhl. 655/2004 Z. z.:
// "priemerná mesačná mzda zamestnanca hospodárstva SR za prvý polrok
// predchádzajúceho kalendárneho roka" (ak ods. 4 neustanovuje inak). The režijný
// paušál per úkon (§ 16 ods. 3) is 1/100 of this. Keyed by the YEAR of the úkon.
//
// Values = ŠÚ SR average nominal monthly wage (economy of the SR), 1.–2. Q of
// year (Y-1), table pr0204qs. Covers úkon years 2013–2026; for years outside
// this range the engine warns and falls back to a supplied flatRatePerAct.
// Adding a future year is a one-line change.
const SK_VYPOCTOVY_ZAKLAD = {
  2013: 781,   // H1 2012  -> paušál 7,81 €
  2014: 804,   // H1 2013  -> 8,04 €
  2015: 839,   // H1 2014  -> 8,39 €
  2016: 858,   // H1 2015  -> 8,58 €
  2017: 884,   // H1 2016  -> 8,84 €
  2018: 921,   // H1 2017  -> 9,21 €
  2019: 980,   // H1 2018  -> 9,80 €
  2020: 1062,  // H1 2019  -> 10,62 €
  2021: 1087,  // H1 2020  -> 10,87 €
  2022: 1163,  // H1 2021  -> 11,63 €
  2023: 1252,  // H1 2022  -> 12,52 €
  2024: 1373,  // H1 2023  -> 13,73 €
  2025: 1484,  // H1 2024  -> 14,84 €
  2026: 1586,  // H1 2025  -> 15,86 €
};

// Resolve the calendar year from an input that may carry { year } or { date }.
function resolveYear(input) {
  if (input.year != null) return Math.floor(num(input.year));
  if (input.date) {
    const m = String(input.date).match(/^(\d{4})/);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

// Normalize `input.acts` into a list of individual act-of-legal-service
// entries, each carrying its own performance date/year. The paušál (§ 16
// ods. 3) is keyed to the YEAR OF THE ÚKON, so a case whose acts span
// several years (e.g. 2019 filing, 2026 closing submission) must resolve
// each act's paušál against that act's own year, not a single case-wide
// date. Accepts either:
//   - a plain number (legacy) -> one entry using the top-level date/year
//   - an array of { date, year, count, desc, multiplier } objects, one per
//     act (or group of identical same-date/same-multiplier acts via `count`)
//
// `multiplier` is the ZSTO (zníženie/zvýšenie sadzby tarifnej odmeny) applied
// to THAT act's tariff only — e.g. § 13 ods. 1 (1/2 for a further act of the
// same kind the same day), § 14 (2/3), or a manual increase (e.g. 4x for an
// extraordinarily difficult matter). Mirrors the multiplier list used by
// reference calculators (ASPI): 0, 1/4, 1/3, 1/2, 2/3, 1 (100%, default),
// 1.25 (125%), 4. Never applied to the paušál, which § 16 ods. 3 keys only
// to the act's year, not to how the tariff itself was reduced/increased.
function normalizeActs(input) {
  if (Array.isArray(input.acts)) {
    return input.acts.map(a => {
      a = a || {};
      const count = a.count != null ? Math.max(0, Math.floor(num(a.count))) : 1;
      const year = a.date ? resolveYear({ date: a.date })
                 : (a.year != null ? Math.floor(num(a.year)) : resolveYear(input));
      const multiplier = a.multiplier != null ? num(a.multiplier) : 1;
      return { date: a.date || null, year, count, desc: a.desc || null, multiplier };
    });
  }
  const count = input.acts != null ? Math.max(0, Math.floor(num(input.acts))) : 1;
  return [{ date: input.date || null, year: resolveYear(input), count, desc: null, multiplier: 1 }];
}

// ============================================================
// ATTORNEY FEE — main entry
// ============================================================
//
// input = {
//   jurisdiction: 'SK' | 'CZ',
//   caseType:     'monetary',         // only 'monetary' implemented (default)
//   tariffBase:   number,             // tarifná hodnota; default = principal
//   principal:    number,             // claim principal (default base)
//   acts:         number | [{date, year, count, desc}],  // počet úkonov, or a
//                                     // list of individual acts so each can carry
//                                     // its own performance date (paušál is
//                                     // year-keyed — see normalizeActs above)
//   flatRatePerAct: number,           // OVERRIDE: uniform režijný paušál / paušální
//                                     //   náhrada per úkon for ALL acts, skipping
//                                     //   per-act year resolution. CZ default (when
//                                     //   omitted) 300 Kč per act; SK default is
//                                     //   auto-resolved per act's own year from
//                                     //   SK_VYPOCTOVY_ZAKLAD (1/100 of that year's
//                                     //   výpočtový základ).
//   vat:        boolean,              // platiteľ DPH? (default false)
//   vatRate:    number,               // default by jurisdiction
//   override:   number,               // manual final total (skips computation)
//   currency:   'EUR' | 'CZK',
// }
function calcAttorneyFee(input) {
  input = input || {};
  const warnings = [];
  const jur = input.jurisdiction === 'CZ' ? 'CZ' : 'SK';
  const currency = input.currency || defaultCurrency(jur);
  const caseType = input.caseType || 'monetary';

  const tariffBase = input.tariffBase != null ? num(input.tariffBase) : num(input.principal);
  const actList = normalizeActs(input);
  const acts = actList.reduce((s, a) => s + a.count, 0);

  // manual override short-circuit (always available)
  if (input.override != null) {
    return overrideResult('attorney', jur, currency, num(input.override),
      'Manuálne zadaná odmena (override).', { tariffBase, acts, caseType });
  }

  if (caseType !== 'monetary') {
    warnings.push('caseType „' + caseType + '“ zatiaľ nie je implementovaný — počíta sa ako peňažný (monetary).');
  }
  if (tariffBase <= 0) warnings.push('Tarifná hodnota je nula — skontrolujte istinu / tarifnú hodnotu.');
  if (acts < 1) warnings.push('Počet úkonov je nula.');

  // base tariff per one úkon
  let perAct, legalBasis;
  if (jur === 'CZ') {
    perAct = czAttorneyPerAct(tariffBase);
    legalBasis = 'CZ vyhláška 177/1996 Sb., § 7';
  } else {
    perAct = roundCents(skAttorneyPerAct(tariffBase));
    legalBasis = 'SK vyhláška 655/2004 Z. z., § 10 ods. 1';
  }

  // Per-act figures, resolved PER ACT ENTRY:
  //  - flat expense reimbursement (režijný paušál / paušální náhrada) — § 16
  //    ods. 3 keys the SK paušál to the úkon's own year, so acts in
  //    different years use different values.
  //  - tariff (odmena za úkon) — scaled by that act's ZSTO multiplier (§ 13 /
  //    § 14 reductions such as 1/2 or 2/3 for further same-day acts, or a
  //    manual increase); the multiplier never touches the paušál.
  const actsBreakdown = [];
  let flatTotal = 0;
  let actsFee = 0;
  const missingYears = [];
  actList.forEach(a => {
    let flatRate;
    if (input.flatRatePerAct != null) {
      flatRate = num(input.flatRatePerAct);
    } else if (jur === 'CZ') {
      flatRate = CZ_FLAT_PER_ACT;
    } else {
      const base = a.year != null ? SK_VYPOCTOVY_ZAKLAD[a.year] : null;
      if (base != null) {
        flatRate = roundCents(base / 100);
      } else {
        flatRate = 0;
        pushUnique(missingYears, a.year != null ? String(a.year) : '(neuvedený)');
      }
    }
    const flatSubtotal = jur === 'CZ' ? flatRate * a.count : roundCents(flatRate * a.count);
    flatTotal += flatSubtotal;

    const actRate = jur === 'CZ' ? perAct * a.multiplier : roundCents(perAct * a.multiplier);
    const actSubtotal = jur === 'CZ' ? actRate * a.count : roundCents(actRate * a.count);
    actsFee += actSubtotal;

    actsBreakdown.push({
      date: a.date, year: a.year, count: a.count, desc: a.desc,
      multiplier: a.multiplier, actRate, actSubtotal,
      flatRatePerAct: flatRate, flatSubtotal,
    });
  });
  flatTotal = jur === 'CZ' ? flatTotal : roundCents(flatTotal);
  actsFee = jur === 'CZ' ? actsFee : roundCents(actsFee);
  missingYears.forEach(y => warnings.push('Režijný paušál pre rok ' + y +
    ' nie je v tabuľke — zadajte flatRatePerAct alebo doplňte výpočtový základ (§ 16 ods. 3 vyhl. 655/2004).'));
  // representative per-act rate for display/back-compat (exact when acts share one rate)
  const flatRatePerAct = acts > 0 ? roundCents(flatTotal / acts) : 0;

  const net = actsFee + flatTotal;

  const vat = !!input.vat;
  const vatRate = input.vatRate != null ? num(input.vatRate) : defaultVatRate(jur);
  const vatAmount = vat ? (jur === 'CZ' ? ceilCrown(net * vatRate) : roundCents(net * vatRate)) : 0;
  const total = net + vatAmount;

  return {
    engineVersion: ENGINE_VERSION,
    kind: 'attorney',
    jurisdiction: jur,
    caseType,
    currency,
    tariffBase,
    perAct,
    acts,
    actsFee,
    flatRatePerAct,
    flatTotal,
    actsBreakdown,
    net,
    vat,
    vatRate,
    vatAmount,
    total,
    legalBasis,
    warnings,
  };
}

// ============================================================
// COURT FEE — band logic
// ============================================================

// SK zákon 71/1992 Zb., sadzobník položka 1 písm. a) — z ceny (hodnoty) predmetu
// konania 6 %, najmenej 16,50 €, najviac 16 596,50 € (v obchodných veciach
// najviac 33 193,50 €).
//
// `upominacie` (§ 11c) — návrh na vydanie platobného rozkazu v upomínacom
// konaní: poplatok je POLOVICA percentuálnej sadzby (t. j. 3 % namiesto 6 %).
// The min/max caps below are the general sadzobník pol. 1 a) caps; § 11c's
// text (per available sources) only states the halved percentage rate and
// does not spell out a separately halved min/max, so the general caps are
// applied here and flagged via a warning — verify against the current
// consolidated text if the case is fee-sensitive at the cap boundary.
function skCourtFee(base, commercial, reduced) {
  const rate = reduced ? 0.03 : 0.06;
  const raw = roundCents(base * rate);
  const min = 16.50;
  const max = commercial ? 33193.50 : 16596.50;
  let fee = raw;
  let note = (reduced ? '3 % (upomínacie konanie, § 11c)' : '6 %') + ' z ceny predmetu konania';
  if (fee < min) { fee = min; note = 'minimum 16,50 €'; }
  else if (fee > max) { fee = max; note = 'maximum ' + (commercial ? '33 193,50 €' : '16 596,50 €') + (commercial ? ' (obchodná vec)' : ''); }
  return { fee, raw, min, max, note };
}

// CZ zákon 549/1991 Sb., sazebník položka 1 — peněžité plnění:
//   do 20 000 Kč ............... 1 000 Kč
//   20 000 – 40 000 000 Kč ..... 5 %
//   nad 40 000 000 Kč .......... 2 000 000 Kč + 1 % z částky přes 40 000 000 Kč
//                                (k částce nad 250 000 000 Kč se nepřihlíží)
function czCourtFee(base) {
  let fee, note;
  if (base <= 20000) {
    fee = 1000; note = 'do 20 000 Kč → 1 000 Kč';
  } else if (base <= 40000000) {
    fee = ceilCrown(base * 0.05); note = '5 % z předmětu';
  } else {
    const capped = Math.min(base, 250000000); // k částce nad 250 mil. se nepřihlíží
    fee = ceilCrown(2000000 + (capped - 40000000) * 0.01);
    note = '2 000 000 Kč + 1 % nad 40 mil. Kč';
  }
  return { fee, note };
}

// ============================================================
// COURT FEE — main entry
// ============================================================
//
// input = {
//   jurisdiction: 'SK' | 'CZ',
//   feeType:    'civil-action' | 'upominacie',  // 'upominacie' = SK návrh na
//                                     // platobný rozkaz v upomínacom konaní
//                                     // (§ 11c) — half the percentage rate
//   base:       number,               // cena predmetu konania; default principal
//   principal:  number,
//   commercial: boolean,              // SK obchodná vec → vyšší strop
//   consumerExempt: boolean,          // SK: spotrebiteľ oslobodený od poplatku
//                                     //   (§ 4 ods. 2 písm. za) — fee = 0
//   override:   number,               // manual final amount
//   currency:   'EUR' | 'CZK',
// }
function calcCourtFee(input) {
  input = input || {};
  const warnings = [];
  const jur = input.jurisdiction === 'CZ' ? 'CZ' : 'SK';
  const currency = input.currency || defaultCurrency(jur);
  const feeType = input.feeType || 'civil-action';
  const base = input.base != null ? num(input.base) : num(input.principal);
  const consumerExempt = jur === 'SK' && !!input.consumerExempt;

  if (input.override != null) {
    return overrideResult('court', jur, currency, num(input.override),
      'Manuálne zadaný súdny poplatok (override).', { base, feeType, consumerExempt });
  }

  if (consumerExempt) {
    return {
      engineVersion: ENGINE_VERSION,
      kind: 'court',
      jurisdiction: jur,
      feeType,
      currency,
      base,
      commercial: !!input.commercial,
      consumerExempt: true,
      fee: 0,
      total: 0,
      note: 'oslobodené — spotrebiteľ (§ 4 ods. 2 písm. za) zákona 71/1992 Zb.)',
      legalBasis: 'SK zákon 71/1992 Zb., § 4 ods. 2 písm. za)',
      warnings,
    };
  }

  if (jur === 'SK' && feeType !== 'civil-action' && feeType !== 'upominacie') {
    warnings.push('feeType „' + feeType + '“ zatiaľ nie je implementovaný — počíta sa ako návrh na peňažné plnenie.');
  }
  if (jur === 'CZ' && feeType !== 'civil-action') {
    warnings.push('feeType „' + feeType + '“ zatiaľ nie je implementovaný pre CZ — počíta sa ako návrh na peňažné plnenie.');
  }
  if (base <= 0) warnings.push('Cena predmetu konania je nula — skontrolujte istinu / základ poplatku.');

  let fee, note, legalBasis;
  if (jur === 'CZ') {
    const r = czCourtFee(base);
    fee = r.fee; note = r.note;
    legalBasis = 'CZ zákon 549/1991 Sb., sazebník pol. 1';
  } else {
    const reduced = feeType === 'upominacie';
    const r = skCourtFee(base, !!input.commercial, reduced);
    fee = r.fee; note = r.note;
    legalBasis = reduced
      ? 'SK zákon 71/1992 Zb., § 11c (upomínacie konanie)'
      : 'SK zákon 71/1992 Zb., sadzobník pol. 1 písm. a)';
    if (reduced) {
      warnings.push('Upomínacie konanie: použitá polovičná percentuálna sadzba (3 %); minimum/maximum poplatku sa preberá zo všeobecného sadzobníka pol. 1 a) — overte pri hraničných sumách.');
    }
  }

  return {
    engineVersion: ENGINE_VERSION,
    kind: 'court',
    jurisdiction: jur,
    feeType,
    currency,
    base,
    commercial: !!input.commercial,
    consumerExempt: false,
    fee,
    total: fee,
    note,
    legalBasis,
    warnings,
  };
}

// ============================================================
// SHARED — manual override result shape
// ============================================================
function overrideResult(kind, jur, currency, total, note, extra) {
  return Object.assign({
    engineVersion: ENGINE_VERSION,
    kind,
    jurisdiction: jur,
    currency,
    override: true,
    total,
    net: total,
    note,
    legalBasis: 'manuálne',
    warnings: [],
  }, extra || {});
}

// ============================================================
// COST-ITEM ADAPTER (bridge to lexcalc-engine courtCosts[])
// ============================================================
// Turns any fee/court output into a dated, case-scoped courtCosts[] line item,
// per ROADMAP §2 step 4 (fee/court/trip amounts enter courtCosts[]).
function toCostItem(output, opts) {
  opts = opts || {};
  const labels = { attorney: 'Trovy právneho zastúpenia', court: 'Súdny poplatok' };
  return {
    id: opts.id || (output.kind + '-cost'),
    desc: opts.desc || labels[output.kind] || 'Náklady',
    amount: output.total,
    date: opts.date || null,
    scope: opts.scope || 'all',
  };
}

// ============================================================
// IIFE EXPORT
// ============================================================
return {
  calcAttorneyFee,
  calcCourtFee,
  toCostItem,
  skAttorneyPerAct,
  czAttorneyPerAct,
  skCourtFee,
  czCourtFee,
  SK_VYPOCTOVY_ZAKLAD,
  ENGINE_VERSION,
};

})();

// Universal export: CommonJS (Node / Azure Functions) when available,
// otherwise the global is the IIFE result (browser / SPFx).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = LexCalcFeesEngine;
}
