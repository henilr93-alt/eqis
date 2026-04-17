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

function postIntervalsApi(req, res) {
  try {
    const { searchPulseMinutes, journeyMinutes, fullBookingMinutes } = req.body || {};
    const updates = {};

    if (searchPulseMinutes !== undefined && searchPulseMinutes !== null && searchPulseMinutes !== '') {
      const n = parseInt(searchPulseMinutes, 10);
      if (isNaN(n) || n < 1 || n > 1440) {
        return res.status(400).json({ error: 'searchPulseMinutes must be between 1 and 1440' });
      }
      updates.searchPulseMinutes = n;
    }

    if (journeyMinutes !== undefined && journeyMinutes !== null && journeyMinutes !== '') {
      const n = parseInt(journeyMinutes, 10);
      if (isNaN(n) || n < 1 || n > 1440) {
        return res.status(400).json({ error: 'journeyMinutes must be between 1 and 1440' });
      }
      updates.journeyMinutes = n;
    }

    if (fullBookingMinutes !== undefined && fullBookingMinutes !== null && fullBookingMinutes !== '') {
      const n = parseInt(fullBookingMinutes, 10);
      if (isNaN(n) || n < 1 || n > 1440) {
        return res.status(400).json({ error: 'fullBookingMinutes must be between 1 and 1440' });
      }
      updates.fullBookingMinutes = n;
    }

    const { zipyMinutes } = req.body || {};
    if (zipyMinutes !== undefined && zipyMinutes !== null && zipyMinutes !== '') {
      const n = parseInt(zipyMinutes, 10);
      if (isNaN(n) || n < 1 || n > 1440) {
        return res.status(400).json({ error: 'zipyMinutes must be between 1 and 1440' });
      }
      updates.zipyMinutes = n;
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
