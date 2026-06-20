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
          fullBooking: { status: 'paused', lastRun: null },
          ecd: { status: 'paused', lastRun: null }
        };
        this.saveState();
      }
    } catch (error) {
      logger.error('Failed to load engine state:', error);
      this.state = {
        searchPulse: { status: 'paused', lastRun: null },
        journey: { status: 'paused', lastRun: null },
        fullBooking: { status: 'paused', lastRun: null },
        ecd: { status: 'paused', lastRun: null }
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

  stop(name, opts = {}) {
    // CEO HARD RULE 2026-05-28: protected engines (SearchPulse) only stop
    // when the user explicitly clicks Stop on the dashboard. Any code path
    // that calls stop(name) without { userExplicit: true } gets refused.
    if (this.isProtected(name) && opts.userExplicit !== true) {
      logger.info(`[CRON] stop(${name}) refused — protected engine, only stops on explicit user action`);
      return false;
    }
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
    const engines = ['searchPulse', 'journey', 'fullBooking'];
    
    for (const engine of engines) {
      results[engine] = this.start(engine);
    }
    
    logger.info('Started all engines:', results);
    return results;
  }

  // ── PROTECTED ENGINES (CEO HARD RULE 2026-05-28) ──────────────────
  // SearchPulse is auto-protected: it starts on every boot and CANNOT be
  // paused by automatic actions (FRAKA sleep, stopAll, etc.). It can only
  // be stopped via an EXPLICIT user request — i.e. a call to this.stop()
  // with { userExplicit: true } in the options.
  // SearchPulse parent + all 4 sub-engines are protected (CEO directive #5).
  get PROTECTED_ENGINES() {
    return new Set([
      'searchPulse',
      'searchPulse.flightDom',
      'searchPulse.flightIntl',
      'searchPulse.hotelDom',
      'searchPulse.hotelIntl',
    ]);
  }

  isProtected(name) { return this.PROTECTED_ENGINES.has(name); }

  // New method: Stop all engines at once
  stopAll(opts = {}) {
    const results = {};
    const engines = ['searchPulse', 'journey', 'fullBooking'];
    const allowProtected = opts.userExplicit === true;

    for (const engine of engines) {
      if (this.isProtected(engine) && !allowProtected) {
        results[engine] = 'protected-skipped';
        logger.info(`[CRON] stopAll: skipping protected engine ${engine} (auto-stop ignored — CEO hard rule)`);
        continue;
      }
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
    const engines = ['searchPulse', 'journey', 'fullBooking'];
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
  scheduleJourney(p) { return this._scheduleEngine('journey', p); }
  // BACKWARD COMPAT: single-value scheduleSearchPulse applies the same value to all 4 sub-engines.
  scheduleSearchPulse(p) {
    return this.scheduleSearchPulseAll({ flightDom: p, flightIntl: p, hotelDom: p, hotelIntl: p });
  }
  // NEW (CEO 2026-06-01): per-sub-engine schedules. Each sub-engine = own cron job.
  scheduleSearchPulseAll(perSub) {
    const map = perSub || {};
    const out = {};
    if (map.flightDom  !== undefined) out.flightDom  = this._scheduleEngine('searchPulse.flightDom',  map.flightDom);
    if (map.flightIntl !== undefined) out.flightIntl = this._scheduleEngine('searchPulse.flightIntl', map.flightIntl);
    if (map.hotelDom   !== undefined) out.hotelDom   = this._scheduleEngine('searchPulse.hotelDom',   map.hotelDom);
    if (map.hotelIntl  !== undefined) out.hotelIntl  = this._scheduleEngine('searchPulse.hotelIntl',  map.hotelIntl);
    return out;
  }
  scheduleFullBooking(p) { return this._scheduleEngine('fullBooking', p); }
  scheduleEcd(p) { return this._scheduleEngine('ecd', p); }
  // List of SearchPulse sub-engine names (used by other modules)
  get SEARCH_PULSE_SUB_ENGINES() {
    return ['searchPulse.flightDom', 'searchPulse.flightIntl', 'searchPulse.hotelDom', 'searchPulse.hotelIntl'];
  }

  // Intervals persistence
  _intervalsFile() { return path.join(__dirname, '../state/intervals.json'); }

  getIntervals() {
    try {
      const d = JSON.parse(fs.readFileSync(this._intervalsFile(), 'utf-8'));
      // SearchPulse: prefer nested per-sub-engine map; fall back to legacy flat field.
      const sp = d.searchPulse && typeof d.searchPulse === 'object'
        ? d.searchPulse
        : { flightDom: d.searchPulseMinutes || 3, flightIntl: d.searchPulseMinutes || 3, hotelDom: d.searchPulseMinutes || 3, hotelIntl: d.searchPulseMinutes || 3 };
      const searchPulse = {
        flightDom:  Math.max(1, parseInt(sp.flightDom,  10) || 3),
        flightIntl: Math.max(1, parseInt(sp.flightIntl, 10) || 3),
        hotelDom:   Math.max(1, parseInt(sp.hotelDom,   10) || 3),
        hotelIntl:  Math.max(1, parseInt(sp.hotelIntl,  10) || 3),
      };
      return {
        searchPulse,
        // legacy field still exposed (= min of the 4 sub-engine intervals) for backward compatibility
        searchPulseMinutes: Math.min(searchPulse.flightDom, searchPulse.flightIntl, searchPulse.hotelDom, searchPulse.hotelIntl),
        journeyMinutes: d.journeyMinutes || 30,
        fullBookingMinutes: d.fullBookingMinutes || 60,
        ecdMinutes: d.ecdMinutes || 15,
      };
    } catch {
      const sp = { flightDom: 3, flightIntl: 3, hotelDom: 3, hotelIntl: 3 };
      return { searchPulse: sp, searchPulseMinutes: 3, journeyMinutes: 30, fullBookingMinutes: 60, ecdMinutes: 15 };
    }
  }

  updateIntervals(newI) {
    const cur = this.getIntervals();
    // Merge sub-engine map separately (deep merge)
    const mergedSP = { ...cur.searchPulse };
    if (newI.searchPulse && typeof newI.searchPulse === 'object') {
      for (const k of ['flightDom', 'flightIntl', 'hotelDom', 'hotelIntl']) {
        if (newI.searchPulse[k] !== undefined) {
          const v = parseInt(newI.searchPulse[k], 10);
          if (isFinite(v) && v >= 1) mergedSP[k] = v;
        }
      }
    }
    // Legacy: searchPulseMinutes sets all 4 to same value
    if (newI.searchPulseMinutes !== undefined) {
      const v = parseInt(newI.searchPulseMinutes, 10);
      if (isFinite(v) && v >= 1) {
        mergedSP.flightDom = v; mergedSP.flightIntl = v; mergedSP.hotelDom = v; mergedSP.hotelIntl = v;
      }
    }
    const updated = {
      searchPulse: mergedSP,
      journeyMinutes: newI.journeyMinutes !== undefined ? newI.journeyMinutes : cur.journeyMinutes,
      fullBookingMinutes: newI.fullBookingMinutes !== undefined ? newI.fullBookingMinutes : cur.fullBookingMinutes,
      ecdMinutes: newI.ecdMinutes !== undefined ? newI.ecdMinutes : cur.ecdMinutes,
    };
    fs.writeFileSync(this._intervalsFile(), JSON.stringify(updated, null, 2));
    // Re-schedule whatever was touched
    if (newI.searchPulse || newI.searchPulseMinutes !== undefined) {
      this.scheduleSearchPulseAll(mergedSP);
    }
    if (newI.journeyMinutes !== undefined) this.scheduleJourney(updated.journeyMinutes);
    if (newI.fullBookingMinutes !== undefined) this.scheduleFullBooking(updated.fullBookingMinutes);
    if (newI.ecdMinutes !== undefined) this.scheduleEcd(updated.ecdMinutes);
    // Augment returned shape with legacy field for backward compat
    updated.searchPulseMinutes = Math.min(mergedSP.flightDom, mergedSP.flightIntl, mergedSP.hotelDom, mergedSP.hotelIntl);
    return updated;
  }

  getCronPatterns() {
    const i = this.getIntervals();
    return {
      searchPulse: {
        flightDom:  this._buildCronPattern(i.searchPulse.flightDom),
        flightIntl: this._buildCronPattern(i.searchPulse.flightIntl),
        hotelDom:   this._buildCronPattern(i.searchPulse.hotelDom),
        hotelIntl:  this._buildCronPattern(i.searchPulse.hotelIntl),
      },
      journey: this._buildCronPattern(i.journeyMinutes),
      fullBooking: this._buildCronPattern(i.fullBookingMinutes),
      ecd: this._buildCronPattern(i.ecdMinutes),
    };
  }

  // Enable/disable engine (used by live dashboard toggle buttons)
  setEngineEnabled(name, enabled) {
    if (!this.VALID_ENGINES.includes(name)) return null;
    if (enabled) {
      this.start(name);
    } else {
      // Dashboard toggle = explicit user action — bypass protection
      this.stop(name, { userExplicit: true });
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
    for (const name of ['searchPulse', 'journey', 'fullBooking']) {
      result[name] = this.state[name]?.status || 'paused';
    }
    // also surface the 4 SearchPulse sub-engine statuses
    for (const sub of this.SEARCH_PULSE_SUB_ENGINES) {
      result[sub] = this.state[sub]?.status || 'paused';
    }
    // ECD comparator (toggleable but was missing from this roll-up)
    result['ecd'] = this.state['ecd']?.status || 'paused';
    // Engine 9: merged Flight INTL Audit
    result['flightIntlAudit'] = this.state['flightIntlAudit']?.status || 'paused';
    return result;
  }
  applyPersistedState() { this.loadState(); }

  get VALID_ENGINES() {
    return [
      'searchPulse', 'journey', 'fullBooking', 'ecd',
      'searchPulse.flightDom', 'searchPulse.flightIntl', 'searchPulse.hotelDom', 'searchPulse.hotelIntl',
      // Engine 9: merged Flight INTL Audit (additive; not auto-started).
      'flightIntlAudit',
    ];
  }

  // Engine 9 convenience scheduler (mirrors scheduleEcd). Pattern or minutes.
  scheduleFlightIntlAudit(p) { return this._scheduleEngine('flightIntlAudit', p); }
}

module.exports = new CronManager();