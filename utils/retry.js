const logger = require('./logger');

async function retry(asyncFn, attempts = 2, delayMs = 2000, label = 'operation') {
  let lastError;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await asyncFn();
    } catch (err) {
      lastError = err;
      logger.warn(`[RETRY] ${label} — attempt ${i}/${attempts} failed: ${err.message}`);
      if (i < attempts) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  logger.error(`[RETRY] ${label} — all ${attempts} attempts exhausted`);
  throw lastError;
}

module.exports = retry;
