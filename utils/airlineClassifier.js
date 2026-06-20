// utils/airlineClassifier.js
// Classifies airline names as LCC (Low-Cost Carrier) or FSC (Full-Service Carrier).
// Used by Supplier Health to split the matrix into the two business categories.
//
// classify(name) → 'LCC' | 'FSC' | 'UNKNOWN'
// Names are matched case-insensitively after light normalization.

// Indian + foreign LCCs commonly seen on Etrav
const LCC = new Set([
  // India
  'indigo', '6e', 'spicejet', 'sg', 'goair', 'go first', 'go-first', 'g8',
  'akasa', 'akasa air', 'qp',
  'air india express', 'aix express', 'ix', 'i5',
  // South/SE Asia
  'airasia', 'air asia', 'air asia india', 'i5', 'd7', 'ak',
  'scoot', 'tr',
  'jetstar', 'jq',
  'lion air', 'jt',
  'malindo', 'malindo air', 'od',
  'cebu pacific', '5j', 'cebgo',
  'vietjet', 'vj',
  // Middle East
  'flydubai', 'fly dubai', 'fz',
  'air arabia', 'g9',
  'salam air', 'os', 'oman air express',
  'flynas', 'xy',
  'flyadeal', 'f3',
  'jazeera', 'jazeera airways', 'j9',
  // Europe (rare on this Etrav use case but include)
  'easyjet', 'ryanair', 'wizz air', 'wizz',
  'norwegian', 'eurowings',
]);

// Indian + foreign FSCs commonly seen on Etrav
const FSC = new Set([
  // India
  'air india', 'ai', 'tata airlines',
  'vistara', 'uk',
  // Gulf / Middle East
  'emirates', 'ek', 'emirates airlines',
  'etihad', 'etihad airways', 'ey',
  'qatar airways', 'qatar', 'qr',
  'saudia', 'sv', 'saudi arabian',
  'kuwait airways', 'ku',
  'gulf air', 'gf',
  'oman air', 'wy',
  'royal jordanian', 'rj',
  'middle east airlines', 'me', 'mea',
  // Far East / SE Asia
  'singapore airlines', 'sq', 'singapore',
  'thai airways', 'tg', 'thai',
  'cathay pacific', 'cx', 'cathay',
  'malaysia airlines', 'mh', 'malaysian',
  'china airlines', 'ci',
  'china eastern', 'mu',
  'china southern', 'cz',
  'ana', 'nh', 'all nippon airways',
  'jal', 'jl', 'japan airlines',
  'korean air', 'ke',
  'asiana', 'asiana airlines', 'oz',
  'philippine airlines', 'pr',
  'garuda indonesia', 'garuda', 'ga',
  'biman', 'bg', 'biman bangladesh',
  'vietnam airlines', 'vn',
  'eva air', 'br',
  'srilankan', 'ul', 'sri lankan airlines',
  'pakistan international', 'pia', 'pk',
  // Europe
  'british airways', 'ba',
  'lufthansa', 'lh',
  'klm', 'kl',
  'air france', 'af',
  'turkish airlines', 'turkish', 'tk',
  'iberia', 'ib',
  'finnair', 'ay',
  'swiss', 'lx',
  'austrian', 'os',
  'sas', 'sk',
  // Americas
  'aeroflot', 'su',
  'united', 'united airlines', 'ua',
  'american airlines', 'aa',
  'delta', 'delta air lines', 'dl',
  'air canada', 'ac',
  // Other
  'el al', 'ly',
]);

function _normalize(s) {
  return String(s || '').trim().toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^the\s+/, '');
}

// Common variants that captures may produce when Etrav strips spacing or
// adds suffixes. Lookup-table; bidirectional via classify().
const VARIANTS = [
  // expanded missing 2026-06-02 (per actual captures)
  { match: ['nepal airlines', 'nepalairlines'], to: 'FSC' },
  { match: ['virgin atlantic', 'virgin atlantic airways', 'virginatlantic'], to: 'FSC' },
  { match: ['ita airways', 'itaairways', 'ita'], to: 'FSC' },
  { match: ['air canada', 'aircanada'], to: 'FSC' },
  { match: ['malindo air', 'malindoair', 'malindo'], to: 'LCC' },
  { match: ['flynas airline', 'flynas', 'flynasairline'], to: 'LCC' },
  { match: ['delta air lines', 'delta airlines', 'delta'], to: 'FSC' },
  { match: ['srilankan', 'sri lankan', 'sri lankan airlines', 'srilankan airlines'], to: 'FSC' },
  // Indian
  { match: ['air india express', 'air india xpress', 'aix express', 'aix connect'], to: 'LCC' },
  { match: ['air india', 'airindia'], to: 'FSC' },
  // expanded 2026-06-05: real carriers previously falling through to UNKNOWN
  // and being silently dropped from the Supplier Health LCC/FSC counts.
  // Names taken verbatim from actual Etrav captures in state/supplierHealth.json.
  { match: ['air france', 'airfrance'], to: 'FSC' },
  { match: ['klm', 'klm royal dutch airlines', 'klm royal dutch', 'klmroyaldutchairlines'], to: 'FSC' },
  { match: ['swiss', 'swiss international air lines', 'swiss international airlines', 'swiss international'], to: 'FSC' },
  { match: ['lot polish airlines', 'lot polish', 'lot'], to: 'FSC' },
  { match: ['egyptair', 'egypt air'], to: 'FSC' },
  { match: ['china eastern', 'chinaeastern'], to: 'FSC' },
  { match: ['china southern', 'chinasouthern'], to: 'FSC' },
  { match: ['air china', 'air china limited', 'airchina'], to: 'FSC' },
  { match: ['air astana', 'airastana'], to: 'FSC' },
  { match: ['azerbaijan airlines', 'azerbaijan', 'azal'], to: 'FSC' },
  { match: ['ethiopian airlines', 'ethiopian'], to: 'FSC' },
  { match: ['qantas', 'qantas airways'], to: 'FSC' },
  { match: ['kenya airways', 'kenya'], to: 'FSC' },
  { match: ['uzbekistan airways', 'uzbekistan'], to: 'FSC' },
  { match: ['bhutan airlines', 'druk air', 'drukair'], to: 'FSC' },
  { match: ['alaska airlines', 'alaskaairlines', 'alaska'], to: 'FSC' },
  { match: ['airasia x', 'air asia x', 'airasiax'], to: 'LCC' },
  { match: ['air cairo', 'aircairo'], to: 'LCC' },
];

function _variantClassify(k) {
  for (const v of VARIANTS) {
    if (v.match.includes(k)) return v.to;
  }
  return null;
}

function classify(name) {
  const k = _normalize(name);
  if (!k) return 'UNKNOWN';
  if (LCC.has(k)) return 'LCC';
  if (FSC.has(k)) return 'FSC';
  // 2026-06-02: check variants for common Etrav-captured forms
  const v = _variantClassify(k);
  if (v) return v;
  // soft match: try without "airways"/"airlines" suffix
  const trimmed = k.replace(/\s+(airways|airlines|air|aviation)$/, '');
  if (trimmed !== k) {
    if (LCC.has(trimmed)) return 'LCC';
    if (FSC.has(trimmed)) return 'FSC';
    const v2 = _variantClassify(trimmed);
    if (v2) return v2;
  }
  return 'UNKNOWN';
}

// 2026-06-06 (P3-3): expose VARIANTS + a flattened union for consumers like
// engine7-competitor/ctResultParser that need the full canonical name list
// (otherwise long-haul variants such as "LOT Polish Airlines", "Egyptair",
// "Ethiopian Airlines", "Swiss International Air Lines" are silently absent).
const ALL_KNOWN_NAMES = Array.from(new Set([
  ...LCC,
  ...FSC,
  ...VARIANTS.flatMap(v => v.match),
])).sort();

module.exports = {
  classify,
  LCC: Array.from(LCC),
  FSC: Array.from(FSC),
  VARIANTS,
  ALL_KNOWN_NAMES,
};
