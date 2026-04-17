const cronManager = require('../../utils/cronManager');

function getEnginesApi(req, res) {
  try {
    const states = cronManager.getEngineStates();
    res.json({
      engines: states,
      descriptions: {
        searchPulse: 'Search Pulse Engine — search + results health',
        journey: 'Journey Test Engine — full booking flow',
        zipy: 'Zipy Intelligence — real agent session analysis',
        fullBooking: 'Full Booking Engine — PNR capture + cancel',
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function toggleEngineApi(req, res) {
  try {
    const { name } = req.params;
    const { enabled } = req.body || {};

    if (!cronManager.VALID_ENGINES.includes(name)) {
      return res.status(400).json({ error: `Invalid engine name: ${name}` });
    }

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Body must include {"enabled": boolean}' });
    }

    const state = cronManager.setEngineEnabled(name, enabled);

    // When the user clicks START, trigger an immediate one-off run in addition
    // to resuming the schedule — so the click feels responsive.
    // (fire-and-forget; API returns immediately)
    let immediateRun = false;
    if (enabled) {
      immediateRun = cronManager.runEngineNow(name);
    }

    res.json({
      success: true,
      engine: name,
      enabled,
      immediateRun,
      states: state,
      message: enabled
        ? `Engine ${name} started. ${immediateRun ? 'Run triggered now + ' : ''}will run on schedule.`
        : `Engine ${name} stopped. No scheduled runs until resumed.`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function startAllApi(req, res) {
  try {
    const state = cronManager.resumeAllEngines();
    // Trigger immediate runs for each resumed engine (except fullBooking which stays paused)
    const triggered = [];
    for (const engine of ['searchPulse', 'journey', 'zipy']) {
      if (state[engine] === 'running') {
        try {
          if (cronManager.runEngineNow(engine)) triggered.push(engine);
        } catch { /* ignore */ }
      }
    }
    res.json({
      success: true,
      states: state,
      triggered,
      message: `All engines started. Triggered now: ${triggered.join(', ') || 'none'}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function stopAllApi(req, res) {
  try {
    const state = cronManager.pauseAllEngines();
    res.json({
      success: true,
      states: state,
      message: 'All engines paused. No scheduled runs will fire until resumed.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  getEnginesApi,
  toggleEngineApi,
  startAllApi,
  stopAllApi,
};
