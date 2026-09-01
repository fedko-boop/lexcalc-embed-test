// LexCalc Work-Trip Engine — Pure calculation module (no DOM, no I/O, no date-now reads)
// Domestic travel-compensation (cestovné náhrady / cestovní náhrady), with
// date-effective legislative timelines for amortization (amortizácia/základní
// náhrada), meal allowances (stravné) and average fuel prices (PHM):
//   SK: zákon č. 283/2002 Z. z.
//   CZ: zákon č. 262/2006 Sb. (zákoník práce), § 157–190; yearly rates set by
//       MPSV vyhláška (e.g. 467/2022 for 2023, 398/2023 for 2024, 475/2024 for
//       2025, 573/2025 for 2026).
//
// Extracted from the standalone fedko-boop/work_trip UI (single HTML file) so the
// same logic can run unchanged in the browser, an SPFx/PCF control, Node.js /
// Azure Functions or Power Automate — exactly like lexcalc-engine.js.
//
// Input:  a single WorkTripInput object  (one trip-day)
// Output: a single WorkTripOutput object
// Use calculateMany([...]) to sum a batch of days (rates may differ per date).
//
// input.jurisdiction: 'SK' (default) | 'CZ' selects the built-in fallback
// tables and fuel-type columns below; injected input.tables.{amort,meal,fuel}
// always override regardless of jurisdiction (caller supplies the matching
// table). CZ fuel types are 'benzín95' | 'benzín98' | 'nafta' | 'elektrina'
// (two petrol grades, per the CZ vyhláška), unlike SK's single 'benzín'.
const WorkTripEngine = (() => {

const ENGINE_VERSION = '1.0.0';

// ============================================================
// LEGISLATIVE DATA (date-effective fallbacks; all injectable)
// ============================================================

// Náhrada za 1 km jazdy (amortizácia) — €/km, by effective date.
const AMORT_RATES = [
  { from: '2023-07-01', rate: 0.252, reg: '247/2023 Z. z.' },
  { from: '2024-05-01', rate: 0.265, reg: '73/2024 Z. z.' },
  { from: '2025-03-01', rate: 0.281, reg: '22/2025 Z. z.' },
  { from: '2025-06-01', rate: 0.296, reg: '97/2025 Z. z.' },
  { from: '2026-01-01', rate: 0.313, reg: '340/2025 Z. z.' },
];

// Tuzemské stravné (€) podľa časových pásiem 5–12 / 12–18 / nad 18 h, by effective date.
const MEAL_RATES = [
  { from: '2023-10-01', m1: 7.80, m2: 11.60, m3: 17.40, reg: '432/2023 Z. z.' },
  { from: '2024-09-01', m1: 8.30, m2: 12.30, m3: 18.40, reg: '211/2024 Z. z.' },
  { from: '2025-04-01', m1: 8.80, m2: 13.10, m3: 19.50, reg: '39/2025 Z. z.' },
  { from: '2025-12-01', m1: 9.30, m2: 13.80, m3: 20.60, reg: '280/2025 Z. z.' },
];

// Priemerné týždenné ceny PHM v SR (€/l) — [dátum od, benzín 95, nafta, LPG].
// Zdroj: ŠÚ SR (sp0207ts). Full weekly series 2023-01-02 .. 2026-06-01,
// ported verbatim from the standalone fedko-boop/work_trip app's
// BUILTIN_FUEL table (was a sparse ~9-row subset here before; the standalone
// app carried the complete weekly series). Still overridable via
// input.tables.fuel for callers who maintain their own feed.
const FUEL_PRICES = [
  ['2023-01-02',1.491,1.619,0.792],['2023-01-09',1.489,1.617,0.788],['2023-01-16',1.519,1.607,0.785],
  ['2023-01-23',1.578,1.606,0.781],['2023-01-30',1.598,1.601,0.781],['2023-02-06',1.57,1.553,0.788],
  ['2023-02-13',1.569,1.552,0.786],['2023-02-20',1.564,1.546,0.804],['2023-02-27',1.564,1.545,0.803],
  ['2023-03-06',1.562,1.558,0.788],['2023-03-13',1.511,1.527,0.788],['2023-03-20',1.508,1.524,0.752],
  ['2023-03-27',1.532,1.501,0.749],['2023-04-03',1.601,1.496,0.74],['2023-04-10',1.605,1.493,0.736],
  ['2023-04-17',1.581,1.472,0.721],['2023-04-24',1.562,1.452,0.721],['2023-05-01',1.532,1.421,0.699],
  ['2023-05-08',1.525,1.413,0.695],['2023-05-15',1.565,1.423,0.692],['2023-05-22',1.589,1.429,0.691],
  ['2023-05-29',1.585,1.425,0.692],['2023-06-05',1.584,1.423,0.685],['2023-06-12',1.58,1.433,0.696],
  ['2023-06-19',1.589,1.456,0.697],['2023-06-26',1.574,1.443,0.698],['2023-07-03',1.566,1.428,0.704],
  ['2023-07-10',1.587,1.474,0.691],['2023-07-17',1.589,1.475,0.693],['2023-07-24',1.647,1.506,0.692],
  ['2023-07-31',1.703,1.563,0.693],['2023-08-07',1.689,1.614,0.694],['2023-08-14',1.701,1.616,0.696],
  ['2023-08-21',1.716,1.633,0.694],['2023-08-28',1.719,1.637,0.694],['2023-09-04',1.69,1.646,0.696],
  ['2023-09-11',1.711,1.69,0.7],['2023-09-18',1.72,1.707,0.7],['2023-09-25',1.704,1.705,0.7],
  ['2023-10-02',1.641,1.684,0.7],['2023-10-09',1.614,1.661,0.7],['2023-10-16',1.606,1.677,0.701],
  ['2023-10-23',1.649,1.669,0.708],['2023-10-30',1.648,1.647,0.708],['2023-11-06',1.587,1.627,0.709],
  ['2023-11-13',1.584,1.597,0.708],['2023-11-20',1.568,1.593,0.707],['2023-11-27',1.565,1.594,0.706],
  ['2023-12-04',1.534,1.539,0.706],['2023-12-11',1.512,1.509,0.706],['2023-12-18',1.529,1.521,0.707],
  ['2023-12-25',1.551,1.503,0.708],['2024-01-01',1.553,1.503,0.708],['2024-01-08',1.527,1.485,0.706],
  ['2024-01-15',1.551,1.511,0.705],['2024-01-22',1.575,1.554,0.706],['2024-01-29',1.602,1.591,0.705],
  ['2024-02-05',1.602,1.591,0.706],['2024-02-12',1.622,1.641,0.706],['2024-02-19',1.624,1.612,0.706],
  ['2024-02-26',1.623,1.59,0.706],['2024-03-04',1.624,1.589,0.705],['2024-03-11',1.607,1.569,0.704],
  ['2024-03-18',1.635,1.596,0.705],['2024-03-25',1.655,1.57,0.703],['2024-04-01',1.68,1.566,0.7],
  ['2024-04-08',1.696,1.572,0.699],['2024-04-15',1.694,1.57,0.699],['2024-04-22',1.659,1.541,0.696],
  ['2024-04-29',1.66,1.541,0.698],['2024-05-06',1.631,1.516,0.695],['2024-05-13',1.622,1.507,0.694],
  ['2024-05-20',1.62,1.505,0.695],['2024-05-27',1.61,1.497,0.695],['2024-06-03',1.577,1.472,0.68],
  ['2024-06-10',1.58,1.477,0.683],['2024-06-17',1.599,1.523,0.683],['2024-06-24',1.622,1.538,0.684],
  ['2024-07-01',1.624,1.541,0.686],['2024-07-08',1.613,1.526,0.687],['2024-07-15',1.597,1.509,0.688],
  ['2024-07-22',1.592,1.505,0.689],['2024-07-29',1.579,1.484,0.687],['2024-08-05',1.572,1.477,0.713],
  ['2024-08-12',1.568,1.474,0.72],['2024-08-19',1.549,1.459,0.719],['2024-08-26',1.529,1.443,0.719],
  ['2024-09-02',1.516,1.428,0.717],['2024-09-09',1.477,1.403,0.716],['2024-09-16',1.477,1.402,0.715],
  ['2024-09-23',1.475,1.401,0.715],['2024-09-30',1.477,1.402,0.714],['2024-10-07',1.495,1.42,0.739],
  ['2024-10-14',1.518,1.424,0.736],['2024-10-21',1.516,1.418,0.732],['2024-10-28',1.499,1.422,0.736],
  ['2024-11-04',1.496,1.421,0.736],['2024-11-11',1.504,1.441,0.749],['2024-11-18',1.506,1.46,0.752],
  ['2024-11-25',1.521,1.479,0.752],['2024-12-02',1.507,1.459,0.752],['2024-12-09',1.505,1.459,0.753],
  ['2024-12-16',1.524,1.477,0.746],['2024-12-23',1.524,1.474,0.748],['2024-12-30',1.561,1.509,0.768],
  ['2025-01-06',1.563,1.514,0.771],['2025-01-13',1.594,1.546,0.766],['2025-01-20',1.612,1.568,0.766],
  ['2025-01-27',1.589,1.549,0.763],['2025-02-03',1.587,1.549,0.763],['2025-02-10',1.586,1.546,0.765],
  ['2025-02-17',1.587,1.547,0.765],['2025-02-24',1.573,1.551,0.775],['2025-03-03',1.543,1.522,0.777],
  ['2025-03-10',1.506,1.483,0.772],['2025-03-17',1.506,1.48,0.773],['2025-03-24',1.52,1.479,0.769],
  ['2025-03-31',1.55,1.493,0.761],['2025-04-07',1.508,1.454,0.728],['2025-04-14',1.486,1.418,0.731],
  ['2025-04-21',1.482,1.41,0.729],['2025-04-28',1.479,1.398,0.724],['2025-05-05',1.479,1.39,0.702],
  ['2025-05-12',1.494,1.388,0.701],['2025-05-19',1.503,1.403,0.69],['2025-05-26',1.505,1.393,0.69],
  ['2025-06-02',1.496,1.393,0.687],['2025-06-09',1.495,1.393,0.686],['2025-06-16',1.532,1.428,0.687],
  ['2025-06-23',1.538,1.453,0.687],['2025-06-30',1.499,1.441,0.688],['2025-07-07',1.496,1.462,0.688],
  ['2025-07-14',1.49,1.464,0.687],['2025-07-21',1.511,1.483,0.691],['2025-07-28',1.512,1.484,0.69],
  ['2025-08-04',1.524,1.465,0.687],['2025-08-11',1.504,1.422,0.684],['2025-08-18',1.501,1.419,0.682],
  ['2025-08-25',1.516,1.434,0.682],['2025-09-01',1.528,1.448,0.679],['2025-09-08',1.544,1.459,0.68],
  ['2025-09-15',1.53,1.458,0.677],['2025-09-22',1.522,1.459,0.674],['2025-09-29',1.516,1.47,0.673],
  ['2025-10-06',1.513,1.453,0.676],['2025-10-13',1.5,1.429,0.676],['2025-10-20',1.48,1.428,0.677],
  ['2025-10-27',1.519,1.467,0.677],['2025-11-03',1.515,1.463,0.676],['2025-11-10',1.532,1.514,0.677],
  ['2025-11-17',1.548,1.517,0.675],['2025-11-24',1.512,1.491,0.675],['2025-12-01',1.499,1.454,0.676],
  ['2025-12-08',1.482,1.432,0.677],['2025-12-15',1.454,1.408,0.677],['2025-12-22',1.449,1.4,0.679],
  ['2025-12-29',1.45,1.401,0.678],['2026-01-05',1.44,1.388,0.677],['2026-01-12',1.453,1.402,0.677],
  ['2026-01-19',1.454,1.427,0.674],['2026-01-26',1.473,1.448,0.674],['2026-02-02',1.474,1.466,0.676],
  ['2026-02-09',1.474,1.467,0.677],['2026-02-16',1.474,1.467,0.677],['2026-02-23',1.474,1.466,0.675],
  ['2026-03-02',1.487,1.483,0.68],['2026-03-09',1.524,1.533,0.681],['2026-03-16',1.531,1.573,0.683],
  ['2026-03-23',1.577,1.687,0.737],['2026-03-30',1.665,1.751,0.752],['2026-04-06',1.669,1.75,0.852],
  ['2026-04-13',1.694,1.772,0.901],['2026-04-20',1.688,1.787,0.901],['2026-04-27',1.777,1.849,0.912],
  ['2026-05-04',1.768,1.77,0.906],['2026-05-11',1.776,1.71,0.882],['2026-05-18',1.801,1.719,0.882],
  ['2026-05-25',1.737,1.648,0.867],['2026-06-01',1.697,1.627,0.865]
];

// Maps fuel type -> column index in a fuel row (1=benzín, 2=nafta, 3=LPG).
// null = no price series (e.g. elektrina) -> caller supplies a manual price.
const FUEL_COL = { 'benzín': 1, 'nafta': 2, 'LPG': 3, 'elektrina': null };

// Default fuel price used only when there is neither a series value nor an override.
const DEFAULT_FUEL_PRICE = 1.600;

// Vehicle types that do not reimburse per-km (use a ticket cost instead).
const PUBLIC_TRANSPORT = ['vlak', 'autobus', 'lietadlo'];

// ============================================================
// CZ LEGISLATIVE DATA (date-effective fallbacks; all injectable)
// ============================================================
// zákon č. 262/2006 Sb. (zákoník práce) §157–190; yearly rate/price vyhláška
// (MPSV): 467/2022 Sb. (2023, amended 85/2023 + 191/2023 mid-year for nafta),
// 398/2023 Sb. (2024), 475/2024 Sb. (2025), 573/2025 Sb. (2026). Only figures
// cross-checked across independent sources are seeded here — same discipline
// as the SK výpočtový základ table in lexcalc-fees-engine.js. A mid-2026
// emergency correction to the diesel price (§189 odst. 4 — MPSV may adjust
// mid-year on a ≥20% price swing) is included as a second dated entry.

// Základní náhrada za 1 km jízdy osobním vozidlem — Kč/km, by effective date.
const CZ_AMORT_RATES = [
  { from: '2023-01-01', rate: 5.20, reg: 'vyhl. 467/2022 Sb.' },
  { from: '2024-01-01', rate: 5.60, reg: 'vyhl. 398/2023 Sb.' },
  { from: '2025-01-01', rate: 5.80, reg: 'vyhl. 475/2024 Sb.' },
  { from: '2026-01-01', rate: 5.90, reg: 'vyhl. 573/2025 Sb.' },
];

// Tuzemské stravné (Kč), private-sector minimum, podle 5–12 / 12–18 / nad 18 h.
const CZ_MEAL_RATES = [
  { from: '2023-01-01', m1: 129, m2: 196, m3: 307, reg: 'vyhl. 467/2022 Sb.' },
  { from: '2024-01-01', m1: 140, m2: 212, m3: 333, reg: 'vyhl. 398/2023 Sb.' },
  { from: '2025-01-01', m1: 148, m2: 225, m3: 353, reg: 'vyhl. 475/2024 Sb.' },
  { from: '2026-01-01', m1: 155, m2: 236, m3: 370, reg: 'vyhl. 573/2025 Sb.' },
];

// Průměrné ceny PHM v ČR (Kč/l, elektřina Kč/kWh) — [dátum od, benzín 95, benzín 98, nafta, elektřina].
// null = not sourced for that period.
const CZ_FUEL_PRICES = [
  ['2023-01-01', 41.20, 45.20, 44.10, null],
  ['2023-07-01', 41.20, 45.20, 34.40, null],   // vyhl. 191/2023 Sb. — mid-year nafta correction
  ['2024-01-01', 38.20, 42.60, 38.70, null],
  ['2025-01-01', 35.80, 40.50, 34.70, 7.70],
  ['2026-01-01', 34.70, 39.00, 34.10, 7.20],
  ['2026-06-01', 34.70, 39.00, 44.50, 7.20],   // §189 odst. 4 mid-year correction (≥20% nafta swing)
];

// Maps CZ fuel type -> column index (1=benzín95, 2=benzín98, 3=nafta, 4=elektřina).
const CZ_FUEL_COL = { 'benzín95': 1, 'benzín98': 2, 'nafta': 3, 'elektrina': 4 };

// ============================================================
// HELPERS
// ============================================================

// Parse a float safely, returning 0 on failure (mirrors UI `num`).
function num(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

// Parse "HH:MM" -> minutes since midnight, or null.
function parseTime(t) {
  if (!t) return null;
  const m = String(t).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// Return the last entry in a date-sorted list whose `.from` <= date.
// Falls back to the earliest entry if date precedes all of them.
function effectiveEntry(list, date) {
  if (!Array.isArray(list) || !list.length || !date) return null;
  let found = null;
  for (let i = 0; i < list.length; i++) {
    if (list[i].from <= date) found = list[i];
    else break;
  }
  return found || list[0];
}

// Sort a copy of a {from,...} table ascending by date.
function sortByFrom(list) {
  return (list || []).slice().sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
}

// Sort a copy of a fuel-row table (row[0] = date) ascending by date.
function sortFuel(list) {
  return (list || []).slice().sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// ============================================================
// LEGISLATIVE LOOKUPS (date -> effective value)
// ============================================================

// Effective amortization (currency/km) for a date, with regulation label.
// `jur` selects the built-in fallback when no table is injected.
function amortForDate(date, table, jur) {
  const e = effectiveEntry(sortByFrom(table || (jur === 'CZ' ? CZ_AMORT_RATES : AMORT_RATES)), date);
  return e ? { rate: num(e.rate), reg: e.reg || '' } : { rate: 0, reg: '' };
}

// Effective meal tiers for a date, with regulation label.
function mealForDate(date, table, jur) {
  const e = effectiveEntry(sortByFrom(table || (jur === 'CZ' ? CZ_MEAL_RATES : MEAL_RATES)), date);
  return e
    ? { m1: num(e.m1), m2: num(e.m2), m3: num(e.m3), reg: e.reg || '' }
    : { m1: 0, m2: 0, m3: 0, reg: '' };
}

// Effective fuel price (currency/l, or currency/kWh for elektřina) for a date
// and fuel type from the price series. Returns null when the type has no
// series or no data for that period.
function fuelForDate(date, fuelType, table, jur) {
  const col = (jur === 'CZ' ? CZ_FUEL_COL : FUEL_COL)[fuelType];
  if (col == null) return null;
  const data = sortFuel(table || (jur === 'CZ' ? CZ_FUEL_PRICES : FUEL_PRICES));
  if (!data.length || !date) return null;
  let found = null;
  for (let i = 0; i < data.length; i++) {
    if (data[i][0] <= date) found = data[i];
    else break;
  }
  const row = found || data[0];
  const v = row[col];
  return (v == null || isNaN(v)) ? null : Number(v);
}

// ============================================================
// TRIP-LEVEL CALCULATIONS
// ============================================================

// Trip duration in hours = latest arrival - earliest departure across legs.
// Handles a single midnight crossing.
function tripDurationHours(legs) {
  let firstDep = null;
  let lastArr = null;
  (legs || []).forEach((l) => {
    const d = parseTime(l.depTime);
    const a = parseTime(l.arrTime);
    if (d != null && (firstDep == null || d < firstDep)) firstDep = d;
    if (a != null && (lastArr == null || a > lastArr)) lastArr = a;
  });
  if (firstDep == null || lastArr == null) return 0;
  let diff = lastArr - firstDep;
  if (diff < 0) diff += 24 * 60; // crosses midnight (single-day assumption)
  return diff / 60;
}

// Sum of all leg distances (km).
function totalKm(legs) {
  return (legs || []).reduce((s, l) => s + num(l.km), 0);
}

// Meal allowance tier from duration (hours) using resolved tier amounts.
// band: 0 = no entitlement, 1 = 5–12 h, 2 = 12–18 h, 3 = over 18 h.
function mealTier(hours, tiers) {
  if (hours < 5) return { amount: 0, band: 0, label: 'menej ako 5 hodín – bez nároku' };
  if (hours < 12) return { amount: num(tiers.m1), band: 1, label: '5 – 12 hodín' };
  if (hours < 18) return { amount: num(tiers.m2), band: 2, label: '12 – 18 hodín' };
  return { amount: num(tiers.m3), band: 3, label: 'nad 18 hodín' };
}

// True if any leg touches a non-SK country code (foreign travel not modelled).
function hasForeign(legs) {
  return (legs || []).some((l) =>
    (l.fromCountry && l.fromCountry !== 'SK') ||
    (l.toCountry && l.toCountry !== 'SK'));
}

// ============================================================
// MAIN ENTRY — calculate one trip-day
// ============================================================
//
// WorkTripInput = {
//   date: 'YYYY-MM-DD',                 // drives legislative resolution (required)
//   vehicleType: 'vlastne'|'firemne'|'vlak'|'autobus'|'lietadlo',  // default 'vlastne'
//   consumption: number,               // l/100 km (own car)
//   fuelType: 'benzín'|'nafta'|'LPG'|'elektrina',
//   legs: [{ depTime:'HH:MM', arrTime:'HH:MM', km, fromCountry?, toCountry? }],
//   transportCost: number,             // ticket cost (public transport)
//   accom: number,                     // accommodation
//   expenses: [{ desc, amount }],       // other expenses
//   overrides: {                        // all optional manual overrides
//     amort, fuelPrice,
//     meal: { m1, m2, m3 },             // override the whole tier table
//     mealAmount,                       // fixed meal amount (mealOverride)
//   },
//   defaultFuelPrice: number,          // fallback price (default 1.600)
//   tables: { amort, meal, fuel },     // optional injected legislative tables
// }
function calculate(input) {
  input = input || {};
  const warnings = [];
  const ov = input.overrides || {};
  const tables = input.tables || {};
  const rateSource = (tables.amort || tables.meal || tables.fuel) ? 'injected' : 'fallback';

  const jur = input.jurisdiction === 'CZ' ? 'CZ' : 'SK';
  const currency = input.currency || (jur === 'CZ' ? 'CZK' : 'EUR');
  const legalBasis = jur === 'CZ' ? 'CZ zákon č. 262/2006 Sb., § 157–190' : 'SK zákon č. 283/2002 Z. z.';
  const date = input.date || null;
  const vehicleType = input.vehicleType || 'vlastne';
  const fuelType = input.fuelType || (jur === 'CZ' ? 'benzín95' : 'benzín');
  const consumption = num(input.consumption);
  const legs = input.legs || [];
  const defaultFuelPrice = input.defaultFuelPrice != null ? num(input.defaultFuelPrice) : DEFAULT_FUEL_PRICE;

  if (!date) warnings.push('Bez dátumu cesty sa použijú najstaršie platné legislatívne hodnoty.');

  // --- resolve effective legislative values (override > legislation > 0) ---
  const amortL = amortForDate(date, tables.amort, jur);
  const mealL = mealForDate(date, tables.meal, jur);
  const fuelAuto = fuelForDate(date, fuelType, tables.fuel, jur);
  const fuelColMap = jur === 'CZ' ? CZ_FUEL_COL : FUEL_COL;

  if (date) {
    const amortTable = sortByFrom(tables.amort || (jur === 'CZ' ? CZ_AMORT_RATES : AMORT_RATES));
    if (amortTable.length && date < amortTable[0].from) {
      warnings.push('Dátum cesty predchádza najstaršiu sadzbu amortizácie — použila sa najstaršia známa.');
    }
  }

  const amort = ov.amort != null ? num(ov.amort) : amortL.rate;
  const amortReg = ov.amort != null ? 'manuálne' : amortL.reg;

  let fuelPrice, fuelSource;
  if (ov.fuelPrice != null) {
    fuelPrice = num(ov.fuelPrice);
    fuelSource = 'override';
  } else if (fuelAuto != null) {
    fuelPrice = fuelAuto;
    fuelSource = 'series';
  } else {
    fuelPrice = defaultFuelPrice;
    fuelSource = 'default';
    if (fuelColMap[fuelType] == null) {
      warnings.push('Pre palivo „' + fuelType + '“ neexistuje cenová séria — použila sa predvolená cena.');
    }
  }

  const tiers = ov.meal
    ? { m1: num(ov.meal.m1), m2: num(ov.meal.m2), m3: num(ov.meal.m3), reg: 'manuálne' }
    : mealL;

  // --- core figures ---
  const km = totalKm(legs);
  const ratePerKm = amort + (fuelPrice * consumption / 100);

  let travel;
  if (vehicleType === 'vlastne') {
    travel = km * ratePerKm;
  } else if (vehicleType === 'firemne') {
    travel = 0; // company car: no amortization reimbursement to employee
  } else {
    travel = num(input.transportCost); // ticket cost
    if (PUBLIC_TRANSPORT.indexOf(vehicleType) === -1) {
      warnings.push('Neznámy typ dopravy „' + vehicleType + '“ — použila sa cena lístka.');
    }
  }

  const hours = tripDurationHours(legs);
  const tier = mealTier(hours, tiers);
  const meal = ov.mealAmount != null ? num(ov.mealAmount) : tier.amount;

  const accom = num(input.accom);
  const expenses = input.expenses || [];
  const other = expenses.reduce((s, e) => s + num(e.amount), 0);

  const total = travel + meal + accom + other;

  if (hasForeign(legs)) {
    warnings.push('Cesta obsahuje zahraničný úsek — engine modeluje len tuzemské náhrady (' + jur + ').');
  }

  return {
    engineVersion: ENGINE_VERSION,
    jurisdiction: jur,
    currency,
    legalBasis,
    date,
    vehicleType,
    km,
    consumption,
    amort, amortReg,
    fuelType, fuelPrice, fuelSource,
    ratePerKm,
    travel,
    durationHours: hours,
    mealTier: tier,
    mealTiers: { m1: num(tiers.m1), m2: num(tiers.m2), m3: num(tiers.m3), reg: tiers.reg || '' },
    meal,
    accom,
    other,
    total,
    rateSource,
    warnings,
  };
}

// ============================================================
// BATCH — sum a set of trip-days (rates may differ per date)
// ============================================================
function calculateMany(inputs) {
  const days = (inputs || []).map(calculate);
  const grandTotal = days.reduce((s, d) => s + d.total, 0);
  const warnings = [];
  days.forEach((d) => d.warnings.forEach((w) => { if (warnings.indexOf(w) === -1) warnings.push(w); }));
  return { engineVersion: ENGINE_VERSION, dayCount: days.length, days, grandTotal, warnings };
}

// ============================================================
// COST-ITEM ADAPTER (bridge to lexcalc-engine courtCosts[])
// ============================================================
// Per the roadmap, fee/court/trip outputs are injected into the interest
// engine's courtCosts[] machinery. This produces one dated, case-scoped cost
// line item from a trip output, ready to push into EngineInput.courtCosts[].
function toCostItem(output, opts) {
  opts = opts || {};
  const label = output.jurisdiction === 'CZ' ? 'Cestovní náhrady' : 'Cestovné náhrady';
  return {
    id: opts.id || ('trip-' + (output.date || 'na')),
    desc: opts.desc || (label + (output.date ? ' (' + output.date + ')' : '')),
    amount: output.total,
    date: opts.date || output.date,
    scope: opts.scope || 'all',
  };
}

// ============================================================
// IIFE EXPORT
// ============================================================
return {
  calculate,
  calculateMany,
  toCostItem,
  amortForDate,
  mealForDate,
  fuelForDate,
  tripDurationHours,
  mealTier,
  totalKm,
  AMORT_RATES,
  MEAL_RATES,
  FUEL_PRICES,
  FUEL_COL,
  CZ_AMORT_RATES,
  CZ_MEAL_RATES,
  CZ_FUEL_PRICES,
  CZ_FUEL_COL,
  ENGINE_VERSION,
};

})();

// Universal export: CommonJS (Node / Azure Functions) when available,
// otherwise the global is the IIFE result (browser / SPFx).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = WorkTripEngine;
}
