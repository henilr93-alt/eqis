const cronManager = require('../../utils/cronManager');

function getIntervalsApi(req, res) {
  try {
    const intervals = cronManager.getIntervals();
    const patterns = cronManager.getCronPatterns();
    res.json({
      intervals,
      patterns,
      presets: [
        { label: '1 min', value: 1 },
        { label: '5 min', value: 5 },
        { label: '10 min', value: 10 },
        { label: '15 min', value: 15 },
        { label: '30 min', value: 30 },
        { label: '1 hour', value: 60 },
        { label: '2 hours', value: 120 },
      ],
      limits: { min: 1, max: 1440 },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function _validMin(v) {
  const n = parseInt(v, 10);
  return isFinite(n) && n >= 1 && n <= 1440 ? n : null;
}

function postIntervalsApi(req, res) {
  try {
    const body = req.body || {};
    const updates = {};

    // New nested shape: { searchPulse: { flightDom, flightIntl, hotelDom, hotelIntl } }
    if (body.searchPulse && typeof body.searchPulse === 'object') {
      const sp = {};
      for (const k of ['flightDom', 'flightIntl', 'hotelDom', 'hotelIntl']) {
        if (body.searchPulse[k] !== undefined && body.searchPulse[k] !== null && body.searchPulse[k] !== '') {
          const v = _validMin(body.searchPulse[k]);
          if (v === null) return res.status(400).json({ error: 'searchPulse.' + k + ' must be between 1 and 1440' });
          sp[k] = v;
        }
      }
      if (Object.keys(sp).length > 0) updates.searchPulse = sp;
    }

    // Legacy flat field: searchPulseMinutes applies to all 4 sub-engines
    if (body.searchPulseMinutes !== undefined && body.searchPulseMinutes !== null && body.searchPulseMinutes !== '') {
      const v = _validMin(body.searchPulseMinutes);
      if (v === null) return res.status(400).json({ error: 'searchPulseMinutes must be between 1 and 1440' });
      updates.searchPulseMinutes = v;
    }

    if (body.journeyMinutes !== undefined && body.journeyMinutes !== null && body.journeyMinutes !== '') {
      const v = _validMin(body.journeyMinutes);
      if (v === null) return res.status(400).json({ error: 'journeyMinutes must be between 1 and 1440' });
      updates.journeyMinutes = v;
    }

    if (body.fullBookingMinutes !== undefined && body.fullBookingMinutes !== null && body.fullBookingMinutes !== '') {
      const v = _validMin(body.fullBookingMinutes);
      if (v === null) return res.status(400).json({ error: 'fullBookingMinutes must be between 1 and 1440' });
      updates.fullBookingMinutes = v;
    }

    if (body.ecdMinutes !== undefined && body.ecdMinutes !== null && body.ecdMinutes !== '') {
      const v = _validMin(body.ecdMinutes);
      if (v === null) return res.status(400).json({ error: 'ecdMinutes must be between 1 and 1440' });
      updates.ecdMinutes = v;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid interval updates provided' });
    }

    const result = cronManager.updateIntervals(updates);
    res.json({
      success: true,
      intervals: result,
      patterns: cronManager.getCronPatterns(),
      message: 'Intervals updated. New schedule takes effect immediately.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = { getIntervalsApi, postIntervalsApi };
