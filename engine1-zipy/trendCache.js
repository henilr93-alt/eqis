const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const CACHE_PATH = path.join(__dirname, '..', 'state', 'trendCache.json');

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

async function write(trendObject) {
  const data = {
    generatedAt: new Date().toISOString(),
    forDate: todayStr(),
    trends: trendObject.trends || trendObject,
    dynamicScenarios: trendObject.dynamicScenarios || [],
    mirrorScenarios: trendObject.mirrorScenarios || [],
  };
  fs.writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2));
  logger.info(`[TREND-CACHE] Written for ${data.forDate} (${data.dynamicScenarios.length} dynamic, ${data.mirrorScenarios.length} mirror)`);
}

function read() {
  try {
    if (!fs.existsSync(CACHE_PATH)) return null;
    const raw = fs.readFileSync(CACHE_PATH, 'utf-8');
    const data = JSON.parse(raw);
    if (!data.forDate || data.forDate !== todayStr()) {
      logger.info('[TREND-CACHE] Cache is stale (not from today), returning null');
      return null;
    }
    return data;
  } catch (err) {
    logger.warn(`[TREND-CACHE] Failed to read: ${err.message}`);
    return null;
  }
}

function isStale() {
  try {
    if (!fs.existsSync(CACHE_PATH)) return true;
    const raw = fs.readFileSync(CACHE_PATH, 'utf-8');
    const data = JSON.parse(raw);
    return !data.forDate || data.forDate !== todayStr();
  } catch {
    return true;
  }
}

module.exports = { write, read, isStale };
