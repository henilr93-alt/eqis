const fs = require('fs');
const path = require('path');
const { FLIGHT_SCENARIOS } = require('../scenarios/flightScenarios');
const { HOTEL_SCENARIOS } = require('../scenarios/hotelScenarios');
const { L2B_DOMESTIC_SCENARIOS, L2B_INTERNATIONAL_SCENARIOS, L2B_DOMESTIC_HOTEL_SCENARIOS, L2B_INTERNATIONAL_HOTEL_SCENARIOS } = require('../scenarios/l2bScenarios');

/**
 * Pick a random travel date offset based on real booking patterns:
 * 50% chance: 1-10 days from now (near-term / urgent travel)
 * 30% chance: 11-30 days from now (planned travel)
 * 20% chance: 31-90 days from now (advance booking)
 */
function pickDateOffset() {
  const rand = Math.random();
  if (rand < 0.5) return Math.floor(Math.random() * 10) + 1;       // 1-10 days
  if (rand < 0.8) return Math.floor(Math.random() * 20) + 11;      // 11-30 days
  return Math.floor(Math.random() * 60) + 31;                       // 31-90 days
}

/**
 * Pick trip type: 50% one-way, 50% round-trip
 * For round-trip, also pick a return offset of 4-30 days after departure
 */
function pickTripType() {
  const isRoundTrip = Math.random() < 0.5;
  if (!isRoundTrip) return { tripType: 'one-way', returnOffset: 0 };
  const returnOffset = Math.floor(Math.random() * 27) + 4; // 4-30 days after departure
  return { tripType: 'round-trip', returnOffset };
}

/**
 * Pick random room count: 1-6 rooms
 * Weighted towards 1-2 rooms (most common for agents)
 * 1 room: 40%, 2 rooms: 25%, 3 rooms: 15%, 4 rooms: 10%, 5 rooms: 5%, 6 rooms: 5%
 */
function pickRoomCount() {
  // Tuned from real booking data (Hotel Wise Sales Report, 3,813 bookings):
  // 82% 1 room, 12% 2 rooms, 3% 3 rooms, 1% 4 rooms, 1% 5 rooms, 0.5% 6+ rooms
  const r = Math.random();
  if (r < 0.82) return 1;
  if (r < 0.94) return 2;
  if (r < 0.97) return 3;
  if (r < 0.98) return 4;
  if (r < 0.99) return 5;
  return 6;
}

/**
 * Pick hotel stay length based on real booking data.
 * 41% 1-night, 26% 2-night, 15% 3-night, 8% 4-night, 4% 5-night,
 * 3% 6-7 nights, 3% 8-15 nights (long stays).
 */
function pickHotelNights() {
  const r = Math.random();
  if (r < 0.41) return 1;
  if (r < 0.67) return 2;
  if (r < 0.82) return 3;
  if (r < 0.90) return 4;
  if (r < 0.94) return 5;
  if (r < 0.97) return Math.floor(Math.random() * 2) + 6;  // 6-7
  return Math.floor(Math.random() * 8) + 8;  // 8-15
}

/**
 * Pick a scenario from a list, weighted by bookingCount.
 * Scenarios with more real bookings are more likely to be chosen.
 */
function pickWeightedByBookingCount(list) {
  if (!list || list.length === 0) return null;
  const weights = list.map(s => Math.max(1, s.bookingCount || 1));
  const total = weights.reduce((a, b) => a + b, 0);
  let rand = Math.random() * total;
  for (let i = 0; i < list.length; i++) {
    rand -= weights[i];
    if (rand <= 0) return list[i];
  }
  return list[list.length - 1];
}

/**
 * Pick random hotel pax per room — varies sharing basis per room:
 * Single sharing (1 adult): 30%
 * Double sharing (2 adults): 50% — most common
 * Triple sharing (3 adults): 20%
 * Children per room: 0-2 (60% none, 25% one, 15% two)
 *
 * Returns an array of room configs, one per room.
 * e.g. for 3 rooms: [{ adults: 2, children: 0 }, { adults: 1, children: 1 }, { adults: 3, children: 0 }]
 */
function pickHotelPax(roomCount) {
  // Tuned from real booking data (Hotel Wise Sales Report, 3,813 bookings):
  // Adults/room: 21% 1A, 55% 2A, 7% 3A, 17% default 2A (reflects 4-adult families across 2 rooms)
  // Children/room: 92% none, 6% one, 2% two
  // Total occupants per room capped at 3 (triple sharing max)
  const rooms = [];
  for (let i = 0; i < roomCount; i++) {
    const sharingRand = Math.random();
    let adults;
    if (sharingRand < 0.21) adults = 1;       // 21% single
    else if (sharingRand < 0.76) adults = 2;   // 55% double
    else if (sharingRand < 0.83) adults = 3;   // 7% triple
    else adults = 2;                            // 17% default 2A

    const maxChildren = Math.max(0, 3 - adults);
    let children = 0;
    if (maxChildren > 0) {
      const c = Math.random();
      if (c >= 0.92 && c < 0.98) children = Math.min(1, maxChildren);
      else if (c >= 0.98) children = Math.min(2, maxChildren);
    }

    rooms.push({ adults, children });
  }
  return rooms;
}

/**
 * Build a compact pax label from room configs
 * e.g. "2A 1C × 2, 1A × 1" or "2A × 3" for uniform rooms
 */
function buildHotelPaxLabel(roomPax) {
  // Group rooms by same config
  const groups = {};
  for (const r of roomPax) {
    const key = r.adults + 'A' + (r.children > 0 ? ' ' + r.children + 'C' : '');
    groups[key] = (groups[key] || 0) + 1;
  }
  return Object.entries(groups).map(([k, count]) => k + (count > 1 ? ' ×' + count : '')).join(', ');
}

/**
 * Pick random passenger combination for flights
 * Total pax: 1-9, random mix of adults (1-9) and children (0-4)
 * Adults always >= 1, children capped at total-adults
 * Infants: 0-2 (max 1 per adult)
 */
function pickFlightPax() {
  // Total pax (adults + children) must not exceed 9
  // Infants don't count in seat total but max 1 per adult
  const adults = Math.floor(Math.random() * 9) + 1; // 1-9
  const maxChildren = Math.min(9 - adults, 4); // ensure total <= 9
  const children = maxChildren > 0 ? Math.floor(Math.random() * (maxChildren + 1)) : 0;
  const maxInfants = Math.min(adults, 2); // max 1 infant per adult, cap at 2
  const infants = maxInfants > 0 ? Math.floor(Math.random() * (maxInfants + 1)) : 0;
  return { adults, children, infants };
}

/**
 * Metro cities in India (for business class domestic rule)
 */
const METRO_CITIES = ['DEL', 'BOM', 'BLR', 'MAA', 'CCU', 'HYD', 'AMD', 'PNQ', 'GOI', 'COK'];

/**
 * Pick cabin class based on domestic/international rules:
 * Domestic: 70% Economy, 30% Business (Business only metro-to-metro)
 * International: 50% Economy, 30% Premium Economy, 20% Business
 */
function pickCabinClass(type, from, to) {
  const rand = Math.random();
  if (type === 'domestic') {
    if (rand < 0.7) return 'Economy';
    // Business only if both cities are metros
    if (METRO_CITIES.includes(from) && METRO_CITIES.includes(to)) return 'Business';
    return 'Economy'; // fallback to Economy if not metro-to-metro
  }
  // International
  if (rand < 0.5) return 'Economy';
  if (rand < 0.8) return 'Premium Economy';
  return 'Business';
}

const PULSE_HISTORY_PATH = path.join(__dirname, '..', 'state', 'pulseHistory.json');
const SIGNAL_PATH = path.join(__dirname, '..', 'state', 'searchQualitySignal.json');

function loadPulseHistory() {
  try {
    if (!fs.existsSync(PULSE_HISTORY_PATH)) return { recentIds: [] };
    return JSON.parse(fs.readFileSync(PULSE_HISTORY_PATH, 'utf-8'));
  } catch { return { recentIds: [] }; }
}

function savePulseHistory(newIds, existing) {
  const combined = [...newIds, ...existing.recentIds].slice(0, 12);
  fs.writeFileSync(PULSE_HISTORY_PATH, JSON.stringify({ recentIds: combined }, null, 2));
}

function wasRecentlyUsed(id, history) {
  return (history.recentIds || []).slice(0, 4).includes(id);
}

function getZeroResultFlags() {
  try {
    if (!fs.existsSync(SIGNAL_PATH)) return [];
    const signal = JSON.parse(fs.readFileSync(SIGNAL_PATH, 'utf-8'));
    return (signal.apiHealthSignals || [])
      .filter(s => s.type === 'ZERO_RESULTS')
      .map(s => s.route);
  } catch { return []; }
}

function findScenarioByRoute(routeLabel, ...pools) {
  const flat = pools.flat();
  return flat.find(s => s.from && routeLabel.includes(s.from) && routeLabel.includes(s.to));
}

function pickPulseScenarios(trendData) {
  const mirrorScenarios = trendData?.mirrorScenarios || [];
  const dynamicScenarios = trendData?.dynamicScenarios || [];
  const pulseHistory = loadPulseHistory();

  // ── FLIGHT SELECTION ────────────────────────────────────────
  const mirrorFlights = mirrorScenarios
    .filter(s => s.from && !wasRecentlyUsed(s.id, pulseHistory))
    .sort((a, b) => b.priorityScore - a.priorityScore);

  const dynamicFlights = dynamicScenarios
    .filter(s => (s.from || s.tripType) && !wasRecentlyUsed(s.id, pulseHistory));

  // L2B routes from real agent traffic — rotate through them for realistic coverage
  const l2bDomFlights = L2B_DOMESTIC_SCENARIOS.filter(s => !wasRecentlyUsed(s.id, pulseHistory));
  const l2bIntlFlights = L2B_INTERNATIONAL_SCENARIOS.filter(s => !wasRecentlyUsed(s.id, pulseHistory));
  const prebuiltFlights = FLIGHT_SCENARIOS
    .filter(s => !wasRecentlyUsed(s.id, pulseHistory));

  const zeroResultFlags = getZeroResultFlags();

  // Build ordered candidate list
  const flightCandidates = [
    ...mirrorFlights.filter(s => s.priority === 'CRITICAL'),
    ...zeroResultFlags.map(f => findScenarioByRoute(f, prebuiltFlights, mirrorFlights)).filter(Boolean),
    ...mirrorFlights.filter(s => s.priority === 'HIGH'),
    ...dynamicFlights,
    ...mirrorFlights.filter(s => s.priority === 'MEDIUM'),
    ...prebuiltFlights,
  ];

  // Each sector (domestic/international) runs independently via separate dashboard engines.
  // Pick 1 domestic flight + 1 international flight so both sectors get tested every run.
  const { INTERNATIONAL_DEEP_SCENARIOS } = require('../scenarios/internationalScenarios');
  const allIntlFlights = [...flightCandidates.filter(s => s.type === 'international'), ...(INTERNATIONAL_DEEP_SCENARIOS || [])];

  const flightSearches = [];
  const usedRoutes = new Set();

  // Pick 1 random domestic flight from L2B routes (real agent traffic)
  const shuffledDomL2B = l2bDomFlights.filter(s => !usedRoutes.has(s.from + '-' + s.to)).sort(() => Math.random() - 0.5);
  const domFlight = shuffledDomL2B[0]
    || flightCandidates.find(s => s.type === 'domestic' && !usedRoutes.has(s.from + '-' + s.to))
    || FLIGHT_SCENARIOS.find(s => s.type === 'domestic');
  if (domFlight) { flightSearches.push(domFlight); usedRoutes.add(domFlight.from + '-' + domFlight.to); }

  // Pick 1 random international flight from L2B routes (real agent traffic)
  const shuffledIntlL2B = l2bIntlFlights.filter(s => !usedRoutes.has(s.from + '-' + s.to)).sort(() => Math.random() - 0.5);
  const intlFlight = shuffledIntlL2B[0]
    || allIntlFlights.find(s => !usedRoutes.has(s.from + '-' + s.to))
    || FLIGHT_SCENARIOS.find(s => s.type === 'international');
  if (intlFlight) { flightSearches.push(intlFlight); usedRoutes.add(intlFlight.from + '-' + intlFlight.to); }

  // ── HOTEL SELECTION ─────────────────────────────────────────
  const mirrorHotels = mirrorScenarios
    .filter(s => s.destination && !s.from && !wasRecentlyUsed(s.id, pulseHistory))
    .sort((a, b) => b.priorityScore - a.priorityScore);

  const dynamicHotels = dynamicScenarios.filter(s => s.destination && !s.from);
  const prebuiltHotels = HOTEL_SCENARIOS.filter(s => !wasRecentlyUsed(s.id, pulseHistory));

  const hotelCandidates = [
    ...mirrorHotels.filter(s => s.priority === 'CRITICAL'),
    ...mirrorHotels.filter(s => s.priority === 'HIGH'),
    ...dynamicHotels,
    ...mirrorHotels.filter(s => s.priority === 'MEDIUM'),
    ...prebuiltHotels,
  ];

  // Each sector runs independently — pick 1 random domestic + 1 random international hotel from L2B destinations
  const l2bDomHotels = [...L2B_DOMESTIC_HOTEL_SCENARIOS].sort(() => Math.random() - 0.5);
  const l2bIntlHotels = [...L2B_INTERNATIONAL_HOTEL_SCENARIOS].sort(() => Math.random() - 0.5);
  const domHotel = l2bDomHotels[0] || hotelCandidates.find(s => s.type === 'domestic') || HOTEL_SCENARIOS.find(s => s.type === 'domestic');
  const intlHotel = l2bIntlHotels[0] || hotelCandidates.find(s => s.type === 'international') || HOTEL_SCENARIOS.find(s => s.type === 'international');
  const hotelSearches = [];
  if (domHotel) hotelSearches.push(domHotel);
  if (intlHotel) hotelSearches.push(intlHotel);
  if (hotelSearches.length === 0) {
    const fallback = hotelCandidates[0] || HOTEL_SCENARIOS[0];
    if (fallback) hotelSearches.push(fallback);
  }

  // Update pulse history
  savePulseHistory(
    [...flightSearches, ...hotelSearches].map(s => s.id),
    pulseHistory
  );

  // Clone scenarios before mutating to avoid corrupting cached module objects
  // Apply random date offset + trip type to each flight search
  // Date: 50% near-term (1-10d), 30% planned (11-30d), 20% advance (31-90d)
  // Trip: 50% one-way, 50% round-trip (return 4-30 days after departure)
  const clonedFlights = flightSearches.map(s => {
    const c = { ...s };
    c.dateOffsetDays = pickDateOffset();
    c.dateOffset = c.dateOffsetDays;
    const trip = pickTripType();
    c.tripType = trip.tripType;
    c.returnOffset = trip.returnOffset;
    const pax = pickFlightPax();
    c.passengers = pax;
    c.cabinClass = pickCabinClass(c.type || 'domestic', c.from || '', c.to || '');
    return c;
  });
  const clonedHotels = hotelSearches.map(s => {
    const c = { ...s };
    c.checkinOffset = pickDateOffset();
    c.nights = pickHotelNights();
    c.rooms = pickRoomCount();
    // Vary pax per room — single/double/triple sharing randomly per room
    c.roomPax = pickHotelPax(c.rooms);
    c.adultsPerRoom = c.roomPax[0]?.adults || 2;
    c.childrenPerRoom = c.roomPax[0]?.children || 0;
    c.paxLabel = buildHotelPaxLabel(c.roomPax);
    // Total counts for URL/display
    c.totalAdults = c.roomPax.reduce((sum, r) => sum + r.adults, 0);
    c.totalChildren = c.roomPax.reduce((sum, r) => sum + r.children, 0);
    // No star filter — search without star category selection
    c.starFilter = '';
    return c;
  });

  return { flightSearches: clonedFlights, hotelSearches: clonedHotels };
}

module.exports = { pickPulseScenarios };
