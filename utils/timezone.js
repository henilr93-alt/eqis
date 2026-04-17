const TZ = process.env.TIMEZONE || 'Asia/Kolkata';

/** ISO-like local timestamp: "2026-04-16T14:30:00" */
function getLocalTimestamp() {
  return new Date().toLocaleString('sv-SE', { timeZone: TZ }).replace(' ', 'T');
}

/** Local date string: "2026-04-16" */
function getLocalDateString() {
  return new Date().toLocaleString('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).slice(0, 10);
}

/** Local time HH:MM: "14:30" */
function getLocalTimeString() {
  return new Date().toLocaleString('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false
  });
}

/** Human-readable: "16/4/2026, 2:30:00 pm" */
function getLocalDisplayTimestamp() {
  return new Date().toLocaleString('en-IN', { timeZone: TZ });
}

module.exports = { getLocalTimestamp, getLocalDateString, getLocalTimeString, getLocalDisplayTimestamp, TZ };
