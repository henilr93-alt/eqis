const cron = require('node-cron');
const logger = require('./logger');
const fs = require('fs');
const path = require('path');

class CronManager {
  constructor() {
    this.jobs = new Map();
    this.stateFile = path.join(__dirname, '../state/engineState.json');
    this.loadState();
  }

  loadState() {
    try {
      if (fs.existsSync(this.stateFile)) {
        const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
        // Normalize: convert flat strings ("paused") to nested objects ({ status: "paused" })
        for (const key of Object.keys(data)) {
          if (typeof data[key] === 'string') {
            data[key] = { status: data[key], lastRun: null };
          }
        }
        this.state = data;
      } else {
        this.state = {
          searchPulse: { status: 'paused', lastRun: null },
          journey: { status: 'paused', lastRun: null },
          zipy: { status: 'paused', lastRun: null },
          fullBooking: { status: 'paused', lastRun: null }
        };
        this.saveState();
      }
    } catch (error) {
      logger.error('Failed to load engine state:', error);
      this.state = {
        searchPulse: { status: 'paused', lastRun: null },
        journey: { status: 'paused', lastRun: null },
        zipy: { status: 'paused', lastRun: null },
        fullBooking: { status: 'paused', lastRun: null }
      };
    }
  }

  saveState() {
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
    } catch (error) {
      logger.error('Failed to save engine state:', error);
    }
  }

  schedule(name, cronPattern, task, options = {}) {
    if (this.jobs.has(name)) {
      this.jobs.get(name).stop();
    }

    const job = cron.schedule(cronPattern, async () => {
      if (this.state[name]?.status !== 'running') {
        return;
      }

      try {
        logger.info(`Starting scheduled ${name} run`);
        this.updateEngineState(name, { lastRun: new Date().toISOString() });
        await task();
        logger.info(`Completed scheduled ${name} run`);
      } catch (error) {
        logger.error(`Error in scheduled ${name} run:`, error);
      }
    }, {
      scheduled: false,
      ...options
    });

    this.jobs.set(name, job);
    
    // Initialize state if not exists
    if (!this.state[name]) {
      this.state[name] = { status: 'paused', lastRun: null };
      this.saveState();
    }

    logger.info(`Scheduled ${name} with pattern: ${cronPattern}`);
    return job;
  }

  start(name) {
    const job = this.jobs.get(name);
    if (job) {
      job.start();
      this.updateEngineState(name, { status: 'running' });
      logger.info(`Started cron job: ${name}`);
      return true;
    }
    logger.warn(`Cron job not found: ${name}`);
    return false;
  }

  stop(name) {
    const job = this.jobs.get(name);
    if (job) {
      job.stop();
      this.updateEngineState(name, { status: 'paused' });
      logger.info(`Stopped cron job: ${name}`);
      return true;
    }
    logger.warn(`Cron job not found: ${name}`);
    return false;
  }

  // New method: Start all engines at once
  startAll() {
    const results = {};
    const engines = ['searchPulse', 'journey', 'zipy', 'fullBooking'];
    
    for (const engine of engines) {
      results[engine] = this.start(engine);
    }
    
    logger.info('Started all engines:', results);
    return results;
  }

  // New method: Stop all engines at once
  stopAll() {
    const results = {};
    const engines = ['searchPulse', 'journey', 'zipy', 'fullBooking'];
    
    for (const engine of engines) {
      results[engine] = this.stop(engine);
    }
    
    logger.info('Stopped all engines:', results);
    return results;
  }

  // New method: Force immediate run of an engine
  async forceRun(name, task) {
    try {
      logger.info(`Force running ${name}`);
      this.updateEngineState(name, { lastRun: new Date().toISOString() });
      await task();
      logger.info(`Force run completed for ${name}`);
      return { success: true };
    } catch (error) {
      logger.error(`Force run failed for ${name}:`, error);
      return { success: false, error: error.message };
    }
  }

  getStatus(name) {
    const job = this.jobs.get(name);
    const state = this.state[name] || { status: 'unknown', lastRun: null };
    
    return {
      name,
      status: state.status,
      lastRun: state.lastRun,
      scheduled: !!job,
      running: job ? job.running : false
    };
  }

  // New method: Get status of all engines
  getAllStatus() {
    const engines = ['searchPulse', 'journey', 'zipy', 'fullBooking'];
    const status = {};
    
    for (const engine of engines) {
      status[engine] = this.getStatus(engine);
    }
    
    return status;
  }

  updateEngineState(name, updates) {
    // Handle both flat format ("paused") and nested format ({ status: "paused" })
    if (!this.state[name] || typeof this.state[name] !== 'object') {
      this.state[name] = { status: this.state[name] || 'paused', lastRun: null };
    }

    Object.assign(this.state[name], updates);
    this.saveState();
  }

  destroy(name) {
    const job = this.jobs.get(name);
    if (job) {
      job.stop();
      this.jobs.delete(name);
      logger.info(`Destroyed cron job: ${name}`);
    }
  }

  destroyAll() {
    for (const [name, job] of this.jobs) {
      job.stop();
      logger.info(`Destroyed cron job: ${name}`);
    }
    this.jobs.clear();
  }

  // ── Compatibility layer for eqis.js / frakaApi.js ──────────
  // The codebase uses these function-style APIs extensively.

  setTimezone(tz) { this.timezone = tz || 'Asia/Kolkata'; }

  setRunner(name, fn) {
    if (!this._runners) this._runners = {};
    this._runners[name] = fn;
  }

  _buildCronPattern(minutes) {
    if (minutes >= 60 && minutes % 60 === 0) return '0 */' + (minutes / 60) + ' * * *';
    return '*/' + minutes + ' * * * *';
  }

  _scheduleEngine(name, patternOrMinutes) {
    const pattern = typeof patternOrMinutes === 'number'
      ? this._buildCronPattern(patternOrMinutes)
      : patternOrMinutes;
    const runner = (this._runners && this._runners[name]) || (() => {});
    this.schedule(name, pattern, runner, { timezone: this.timezone || 'Asia/Kolkata' });
    // Respect persisted state from engineState.json — if the engine was running
    // before the server restarted, keep it running. User-initiated stops survive restart.
    const st = this.state[name];
    if (st && st.status === 'running') {
      const job = this.jobs.get(name);
      if (job) {
        job.start();
        logger.info('[CRON] ' + name + ' resumed from persisted "running" state');
      }
    }
    return pattern;
  }

  scheduleZipy(p) { return this._scheduleEngine('zipy', p); }
  scheduleJourney(p) { return this._scheduleEngine('journey', p); }
  scheduleSearchPulse(p) { return this._scheduleEngine('searchPulse', p); }
  scheduleFullBooking(p) { return this._scheduleEngine('fullBooking', p); }

  // Intervals persistence
  _intervalsFile() { return path.join(__dirname, '../state/intervals.json'); }

  getIntervals() {
    try {
      const d = JSON.parse(fs.readFileSync(this._intervalsFile(), 'utf-8'));
      return {
        searchPulseMinutes: d.searchPulseMinutes || 10,
        journeyMinutes: d.journeyMinutes || 30,
        zipyMinutes: d.zipyMinutes || 10,
        fullBookingMinutes: d.fullBookingMinutes || 60,
      };
    } catch {
      return { searchPulseMinutes: 10, journeyMinutes: 30, zipyMinutes: 10, fullBookingMinutes: 60 };
    }
  }

  updateIntervals(newI) {
    const cur = this.getIntervals();
    const updated = { ...cur, ...newI };
    fs.writeFileSync(this._intervalsFile(), JSON.stringify(updated, null, 2));
    if (newI.searchPulseMinutes !== undefined) this.scheduleSearchPulse(updated.searchPulseMinutes);
    if (newI.journeyMinutes !== undefined) this.scheduleJourney(updated.journeyMinutes);
    if (newI.zipyMinutes !== undefined) this.scheduleZipy(updated.zipyMinutes);
    if (newI.fullBookingMinutes !== undefined) this.scheduleFullBooking(updated.fullBookingMinutes);
    return updated;
  }

  getCronPatterns() {
    const i = this.getIntervals();
    return {
      searchPulse: this._buildCronPattern(i.searchPulseMinutes),
      journey: this._buildCronPattern(i.journeyMinutes),
      zipy: this._buildCronPattern(i.zipyMinutes),
      fullBooking: this._buildCronPattern(i.fullBookingMinutes),
    };
  }

  // Enable/disable engine (used by live dashboard toggle buttons)
  setEngineEnabled(name, enabled) {
    if (!this.VALID_ENGINES.includes(name)) return null;
    if (enabled) {
      this.start(name);
    } else {
      this.stop(name);
    }
    return this.state[name] || { status: enabled ? 'running' : 'paused' };
  }

  // Run engine immediately (fire-and-forget, but catch errors)
  runEngineNow(name) {
    if (!this._runners || !this._runners[name]) return false;
    try {
      const result = this._runners[name]();
      // If runner returns a promise (async), catch its errors to prevent unhandled rejections
      if (result && typeof result.catch === 'function') {
        result.catch(err => {
          const logger = require('./logger');
          logger.error(`[CRON] runEngineNow(${name}) async error: ${err.message}`);
        });
      }
      return true;
    } catch (err) {
      const logger = require('./logger');
      logger.error(`[CRON] runEngineNow(${name}) sync error: ${err.message}`);
      return false;
    }
  }

  // Engine state compat
  pauseEngine(name) { return this.stop(name); }
  resumeEngine(name) { return this.start(name); }
  pauseAllEngines() { return this.stopAll(); }
  resumeAllEngines() { return this.startAll(); }
  getEngineStates() {
    const result = {};
    for (const name of ['searchPulse', 'journey', 'zipy', 'fullBooking']) {
      result[name] = this.state[name]?.status || 'paused';
    }
    return result;
  }
  applyPersistedState() { this.loadState(); }

  get VALID_ENGINES() { return ['searchPulse', 'journey', 'zipy', 'fullBooking']; }
}

module.exports = new CronManager();