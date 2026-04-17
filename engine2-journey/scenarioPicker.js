const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { FLIGHT_SCENARIOS } = require('../scenarios/flightScenarios');
const { HOTEL_SCENARIOS } = require('../scenarios/hotelScenarios');
const { INTERNATIONAL_DEEP_SCENARIOS, INTERNATIONAL_WEIGHT_BOOST } = require('../scenarios/internationalScenarios');
const { ROUNDTRIP_SCENARIOS, ROUNDTRIP_WEIGHT_BOOST } = require('../scenarios/roundtripScenarios');

const RUN_HISTORY_PATH = path.join(__dirname, '..', 'state', 'runHistory.json');

function readRunHistory() {
  try {
    if (!fs.existsSync(RUN_HISTORY_PATH)) return [];
    return JSON.parse(fs.readFileSync(RUN_HISTORY_PATH, 'utf-8'));
  } catch { return []; }
}

function getRecentlyUsedIds(history, count = 3) {
  const recent = history.slice(-count);
  const ids = new Set();
  for (const run of recent) {
    if (run.flightScenarioId) ids.add(run.flightScenarioId);
    if (run.hotelScenarioId) ids.add(run.hotelScenarioId);
  }
  return ids;
}

function buildWeightedFlightPool(trendData, excludeIds) {
  const pool = [];

  // Base scenarios (weight 1.0)
  for (const s of FLIGHT_SCENARIOS) {
    if (!excludeIds.has(s.id)) pool.push({ scenario: { ...s, source: 'prebuilt' }, weight: 1.0 });
  }

  // International deep scenarios (weight 1.5)
  for (const s of INTERNATIONAL_DEEP_SCENARIOS) {
    if (!excludeIds.has(s.id)) pool.push({ scenario: { ...s, source: 'prebuilt' }, weight: INTERNATIONAL_WEIGHT_BOOST });
  }

  // Roundtrip scenarios (weight 1.6)
  for (const s of ROUNDTRIP_SCENARIOS) {
    if (!excludeIds.has(s.id)) pool.push({ scenario: { ...s, source: 'prebuilt' }, weight: ROUNDTRIP_WEIGHT_BOOST });
  }

  // Mirror scenarios (weight based on priority)
  for (const s of (trendData?.mirrorScenarios?.filter(m => m.from) || [])) {
    if (!excludeIds.has(s.id)) {
      const w = s.priority === 'CRITICAL' ? 3.0 : s.priority === 'HIGH' ? 2.0 : 1.2;
      pool.push({ scenario: s, weight: w });
    }
  }

  // Dynamic trend scenarios (weight 1.8)
  for (const s of (trendData?.dynamicScenarios?.filter(d => d.from || d.tripType) || [])) {
    if (!excludeIds.has(s.id)) pool.push({ scenario: { ...s, source: 'zipy_trend' }, weight: 1.8 });
  }

  return pool;
}

function buildWeightedHotelPool(trendData, excludeIds) {
  const pool = [];

  for (const s of HOTEL_SCENARIOS) {
    if (!excludeIds.has(s.id)) pool.push({ scenario: { ...s, source: 'prebuilt' }, weight: 1.0 });
  }

  for (const s of (trendData?.mirrorScenarios?.filter(m => m.destination && !m.from) || [])) {
    if (!excludeIds.has(s.id)) {
      const w = s.priority === 'CRITICAL' ? 3.0 : s.priority === 'HIGH' ? 2.0 : 1.2;
      pool.push({ scenario: s, weight: w });
    }
  }

  for (const s of (trendData?.dynamicScenarios?.filter(d => d.destination && !d.from) || [])) {
    if (!excludeIds.has(s.id)) pool.push({ scenario: { ...s, source: 'zipy_trend' }, weight: 1.8 });
  }

  return pool;
}

function weightedPick(weightedPool) {
  if (weightedPool.length === 0) return null;
  const totalWeight = weightedPool.reduce((sum, p) => sum + p.weight, 0);
  let rand = Math.random() * totalWeight;
  for (const p of weightedPool) {
    rand -= p.weight;
    if (rand <= 0) return p.scenario;
  }
  return weightedPool[0].scenario;
}

async function pick(trendData) {
  const history = readRunHistory();
  const recentIds = getRecentlyUsedIds(history);

  // Build weighted pools
  const flightPool = buildWeightedFlightPool(trendData, recentIds);
  const hotelPool = buildWeightedHotelPool(trendData, recentIds);

  // Check for CRITICAL mirror scenarios first (override weighted random)
  const mirrorScenarios = trendData?.mirrorScenarios || [];
  const criticalFlight = mirrorScenarios.find(s => s.from && s.priority === 'CRITICAL' && !recentIds.has(s.id));
  const criticalHotel = mirrorScenarios.find(s => s.destination && !s.from && s.priority === 'CRITICAL' && !recentIds.has(s.id));

  let flightScenario;
  if (criticalFlight) {
    flightScenario = criticalFlight;
    logger.info(`[PICKER] CRITICAL mirror flight: ${flightScenario.label}`);
  } else {
    flightScenario = weightedPick(flightPool) || { ...FLIGHT_SCENARIOS[0], source: 'prebuilt' };
  }

  let hotelScenario;
  if (criticalHotel) {
    hotelScenario = criticalHotel;
    logger.info(`[PICKER] CRITICAL mirror hotel: ${hotelScenario.label}`);
  } else {
    hotelScenario = weightedPick(hotelPool) || { ...HOTEL_SCENARIOS[0], source: 'prebuilt' };
  }

  logger.info(`[PICKER] Flight: ${flightScenario.label} [${flightScenario.source}]`);
  logger.info(`[PICKER] Hotel: ${hotelScenario.label} [${hotelScenario.source}]`);

  return { flightScenario, hotelScenario };
}

module.exports = { pick };
