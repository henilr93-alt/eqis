const logger = require('../utils/logger');

async function run(sessionAnalyses) {
  if (!sessionAnalyses || sessionAnalyses.length === 0) {
    logger.warn('[MIRROR] No session analyses to mirror. Skipping.');
    return [];
  }

  logger.info(`[MIRROR] Building mirror scenarios from ${sessionAnalyses.length} analyzed sessions`);

  const mirrorScenarios = [];

  for (const session of sessionAnalyses) {
    try {
      const mirrors = buildMirrorsFromSession(session);
      mirrorScenarios.push(...mirrors);
    } catch (err) {
      logger.error(`[MIRROR] Failed to mirror session ${session.sessionId}: ${err.message}`);
    }
  }

  const deduplicated = deduplicateMirrors(mirrorScenarios);
  logger.info(`[MIRROR] Generated ${deduplicated.length} mirror scenarios from ${mirrorScenarios.length} raw`);

  await saveMirrorScenarios(deduplicated);
  return deduplicated;
}

function buildMirrorsFromSession(session) {
  const mirrors = [];
  const sp = session.searchPattern;
  if (!sp) return mirrors;

  if (session.productUsed === 'flights' || session.productUsed === 'both') {
    if (sp.origin && sp.destination) {
      const flightMirror = buildFlightMirror(session, sp);
      if (flightMirror) mirrors.push(flightMirror);
    }
  }

  if (session.productUsed === 'hotels' || session.productUsed === 'both') {
    if (sp.hotelDestination) {
      const hotelMirror = buildHotelMirror(session, sp);
      if (hotelMirror) mirrors.push(hotelMirror);
    }
  }

  return mirrors;
}

function buildFlightMirror(session, sp) {
  const today = new Date();

  let dateOffsetDays = 14;
  if (sp.travelDateApprox) {
    try {
      const travelDate = new Date(sp.travelDateApprox);
      const diffDays = Math.ceil((travelDate - today) / (1000 * 60 * 60 * 24));
      if (diffDays > 0 && diffDays <= 365) dateOffsetDays = diffDays;
    } catch (_) { /* use default */ }
  }

  const passengerCount = sp.passengerCount || 1;
  const adults = Math.max(1, passengerCount <= 4 ? passengerCount : Math.floor(passengerCount * 0.8));
  const children = passengerCount > 4 ? Math.floor(passengerCount * 0.2) : 0;

  const cabinClassMap = { business: 'Business', first: 'First', premium: 'Business', economy: 'Economy' };
  const cabinClass = cabinClassMap[sp.cabinClass?.toLowerCase()] || 'Economy';
  const tripType = sp.tripType || 'one-way';
  const filtersToApply = mapFilters(sp.filtersUsed || []);
  const priorityScore = calculatePriorityScore(session);

  return {
    id: `MIRROR-F-${session.sessionId.slice(-6).toUpperCase()}-${Date.now()}`,
    label: `MIRROR: ${sp.origin}→${sp.destination} | ${cabinClass} | ${adults}A${children > 0 ? children + 'C' : ''}`,
    source: 'session_mirror',
    priority: priorityScore >= 7 ? 'CRITICAL' : priorityScore >= 4 ? 'HIGH' : 'MEDIUM',
    priorityScore,
    mirroredFromSession: session.sessionId,
    mirrorReason: buildMirrorReason(session),
    dropOffStep: session.dropOffStep || null,
    bugsInOriginalSession: session.bugsObserved?.length || 0,
    frictionInOriginalSession: session.frictionPoints?.length || 0,
    type: sp.flightType === 'international' ? 'international' : 'domestic',
    tripType,
    from: sp.origin,
    fromCity: sp.originCity || sp.origin,
    to: sp.destination,
    toCity: sp.destinationCity || sp.destination,
    cabinClass,
    passengers: { adults, children, infants: 0 },
    dateOffsetDays,
    returnOffsetDays: tripType === 'round-trip' ? dateOffsetDays + 7 : undefined,
    filtersToApply,
    preferNonStop: sp.filtersUsed?.includes('nonstop') || false,
    generatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

function buildHotelMirror(session, sp) {
  const rooms = sp.roomCount || 1;
  const adultsPerRoom = sp.adultsPerRoom || 2;
  const childrenPerRoom = sp.childrenPerRoom || 0;
  const nights = sp.stayDuration || 3;
  const starFilter = ['3', '4', '5'].includes(sp.hotelStarRating) ? sp.hotelStarRating : '4';
  const filtersToApply = mapFilters(sp.filtersUsed || []);
  const priorityScore = calculatePriorityScore(session);

  return {
    id: `MIRROR-H-${session.sessionId.slice(-6).toUpperCase()}-${Date.now()}`,
    label: `MIRROR: ${sp.hotelDestination} | ${rooms}R ${adultsPerRoom}A | ${nights}N | ${starFilter}★`,
    source: 'session_mirror',
    priority: priorityScore >= 7 ? 'CRITICAL' : priorityScore >= 4 ? 'HIGH' : 'MEDIUM',
    priorityScore,
    mirroredFromSession: session.sessionId,
    mirrorReason: buildMirrorReason(session),
    dropOffStep: session.dropOffStep || null,
    bugsInOriginalSession: session.bugsObserved?.length || 0,
    type: sp.hotelType === 'international' ? 'international' : 'domestic',
    destination: sp.hotelDestination,
    destinationCode: sp.hotelDestinationCode || sp.hotelDestination.slice(0, 3).toUpperCase(),
    checkinOffsetDays: 14,
    nights,
    rooms,
    adultsPerRoom,
    childrenPerRoom,
    starFilter,
    filtersToApply,
    preferRoomType: sp.preferredRoomType || null,
    generatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

function mapFilters(observed) {
  const filterMap = {
    price: 'sort_by_price', price_low: 'sort_by_price', cheapest: 'sort_by_price',
    nonstop: 'nonstop_only', direct: 'nonstop_only', 'non-stop': 'nonstop_only',
    morning: 'morning_flights', duration: 'sort_by_duration', fastest: 'sort_by_duration',
    business: 'business_only', indigo: 'airline_filter_indigo',
    airindia: 'airline_filter_airindia', vistara: 'airline_filter_vistara',
    breakfast: 'free_breakfast', cancellation: 'free_cancellation', refundable: 'free_cancellation',
    rating: 'sort_by_rating', '5star': '5_star', '5 star': '5_star',
  };

  const mapped = [];
  for (const f of observed) {
    const key = f.toLowerCase();
    for (const [pattern, mappedVal] of Object.entries(filterMap)) {
      if (key.includes(pattern) && !mapped.includes(mappedVal)) {
        mapped.push(mappedVal);
      }
    }
  }
  if (mapped.length === 0) mapped.push('sort_by_price');
  return mapped;
}

function calculatePriorityScore(session) {
  let score = 0;
  const p0Count = (session.bugsObserved || []).filter(b => b.severity === 'P0').length;
  const p1Count = (session.bugsObserved || []).filter(b => b.severity === 'P1').length;
  score += p0Count * 3;
  score += p1Count * 2;
  if ((session.frictionPoints || []).some(f => f.type === 'rage_click')) score += 2;
  if (!session.completedToPayment) score += 2;
  if (['results', 'passenger_form', 'review'].includes(session.dropOffStep)) score += 1;
  return Math.min(10, score);
}

function buildMirrorReason(session) {
  const parts = [];
  if (!session.completedToPayment) {
    parts.push(`Real agent dropped off at: ${session.dropOffStep || 'unknown step'}`);
  }
  const bugs = session.bugsObserved || [];
  const p0p1 = bugs.filter(b => ['P0', 'P1'].includes(b.severity));
  if (p0p1.length > 0) {
    parts.push(`${p0p1.length} high-severity bug(s) observed in real session`);
  }
  const rageclicks = (session.frictionPoints || []).filter(f => f.type === 'rage_click');
  if (rageclicks.length > 0) {
    parts.push(`${rageclicks.length} rage click(s) detected`);
  }
  return parts.length > 0 ? parts.join(' | ') : 'Mirrored from real agent session for quality validation';
}

function deduplicateMirrors(mirrors) {
  const seen = new Map();
  for (const m of mirrors) {
    const key = m.from
      ? `F-${m.from}-${m.to}-${m.cabinClass}-${m.passengers?.adults}`
      : `H-${m.destination}-${m.nights}-${m.rooms}`;
    if (!seen.has(key) || m.priorityScore > seen.get(key).priorityScore) {
      seen.set(key, m);
    }
  }
  return Array.from(seen.values()).sort((a, b) => b.priorityScore - a.priorityScore);
}

async function saveMirrorScenarios(scenarios) {
  const fs = require('fs');
  const path = require('path');
  const filePath = path.join(__dirname, '..', 'scenarios', 'mirrorScenarios.js');
  const content = `// AUTO-GENERATED by sessionMirror.js
// Generated at: ${new Date().toISOString()}
// Count: ${scenarios.length} mirror scenarios from today's Zipy session analysis
// TTL: 24 hours — will be replaced on next Zipy engine run
// DO NOT EDIT MANUALLY

const MIRROR_SCENARIOS = ${JSON.stringify(scenarios, null, 2)};

module.exports = { MIRROR_SCENARIOS };
`;
  fs.writeFileSync(filePath, content);
  logger.info(`[MIRROR] Saved ${scenarios.length} mirror scenarios to scenarios/mirrorScenarios.js`);
}

module.exports = { run };
