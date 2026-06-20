// searchpulseActivityApi.js — read the per-category SearchPulse activity
// state file written by utils/searchPulseActivity.js and return a normalized
// array for the dashboard live status bars on the History tab.

function searchPulseActivityApi(req, res) {
  try {
    const data = require('../../utils/searchPulseActivity').get();
    const cats = ['flight-dom', 'flight-intl', 'hotel-dom', 'hotel-intl'];
    const labels = {
      'flight-dom':  'FLIGHT DOM',
      'flight-intl': 'FLIGHT INTL',
      'hotel-dom':   'HOTEL DOM',
      'hotel-intl':  'HOTEL INTL',
    };
    const out = cats.map((k) => ({
      key: k,
      label: labels[k],
      step:      (data[k] && data[k].step)   || 'idle',
      detail:    (data[k] && data[k].detail) || 'No data yet',
      updatedAt: (data[k] && data[k].updatedAt) || null,
    }));
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = { searchPulseActivityApi };
