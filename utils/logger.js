const fs = require('fs');
const path = require('path');
const { getLocalTimestamp, getLocalDateString } = require('./timezone');

const LOG_DIR = path.join(__dirname, '..', 'logs');

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function getLogFile() {
  const today = getLocalDateString();
  return path.join(LOG_DIR, `eqis-${today}.log`);
}

function timestamp() {
  return getLocalTimestamp();
}

function writeToFile(message) {
  try {
    ensureLogDir();
    fs.appendFileSync(getLogFile(), message + '\n');
  } catch (_) {
    // Silently fail file writes — console still shows output
  }
}

function formatMessage(level, msg) {
  return `[${timestamp()}] [${level}] ${msg}`;
}

const logger = {
  info(msg) {
    const formatted = formatMessage('INFO', msg);
    console.log(formatted);
    writeToFile(formatted);
  },

  warn(msg) {
    const formatted = formatMessage('WARN', msg);
    console.warn(formatted);
    writeToFile(formatted);
  },

  error(msg) {
    const formatted = formatMessage('ERROR', msg);
    console.error(formatted);
    writeToFile(formatted);
  },
};

module.exports = logger;
