// flightIntlReviewPulse.js — One Review Pulse attempt on Etrav Flight INTL:
//   1. Wait for results to fully load (Etrav GDS trickles 10-90s)
//   2. Enumerate visible (airline, flight, fareOpt) combos
//   3. Random pick with avoidance of recent picks for this route
//   4. Click "More Fares" inside chosen row (if present), click target fare,
//      click Book Now → expect navigation to /flights/itinerary-page
//   5. Capture review-page metrics + classify outcome
//   6. Return result (engine writes report)

const logger = require('../utils/logger');
const parser = require('./flightResultRowParser');
const picker = require('./randomFarePicker');
const extractor = require('./reviewPageExtractor');
const evaluator = require('./reviewEvaluator');

const ENGINE_KEY = 'flight-intl';
const PAGE_NAV_TIMEOUT_MS = 30000;

async function _clickByMarker(page, marker) {
  // Move the OS cursor smoothly to the centre of the marked element, then
  // click. Smooth move makes the cursor track visible in the video recording.
  try {
    const box = await page.evaluate(function(m) {
      const el = document.querySelector('[data-reviewpulse="' + m + '"]');
      if (!el) return null;
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, marker);
    if (!box) return false;
    await page.mouse.move(box.x, box.y, { steps: 25 });
    await page.waitForTimeout(200);
    await page.mouse.click(box.x, box.y);
    return true;
  } catch { return false; }
}

async function _markAndClickFareOption(page, target) {
  // Find a leaf element that contains "\u20b9<price>" AND the fare label,
  // mark it with data-reviewpulse, then click. SCOPED to the marked row (or
  // its immediate parent) so we never pick a fare option that belongs to a
  // different airline row.
  const found = await page.evaluate(({ priceStr, labelLower }) => {
    const targetPriceText = '\u20b9' + priceStr;
    const row = document.querySelector('[data-reviewpulse="row"]');
    if (!row) return false;
    // Scope search to the row, with one fallback to its parent (Etrav sometimes
    // renders the expanded fare drawer as a sibling of the accordion row).
    const scopes = [row, row.parentElement].filter(Boolean);
    for (const scope of scopes) {
      const all = Array.from(scope.querySelectorAll('div, span, button, label'));
      const candidates = [];
      for (const el of all) {
        const t = (el.textContent || '').trim();
        if (t.length > 250) continue;
        if (t.indexOf(targetPriceText) === -1) continue;
        if (t.toLowerCase().indexOf(labelLower) === -1) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        candidates.push({ el: el, area: r.width * r.height });
      }
      candidates.sort((a, b) => a.area - b.area);
      if (candidates.length > 0) {
        candidates[0].el.setAttribute('data-reviewpulse', 'fare-option');
        return true;
      }
    }
    return false;
  }, { priceStr: target.price.replace(/\.\d+$/, ''), labelLower: target.fareLabel.toLowerCase() }).catch(() => false);
  if (!found) return false;
  return _clickByMarker(page, 'fare-option');
}

// 2026-06-16: roundtrip per-row commit (multi-strategy). The deep audit of
// 2026-06-16 showed Etrav's "Select" label is only used for add-ons (seat
// /meal) — NOT for committing a flight row. So the prior _clickSelectInRow
// helper found nothing on every roundtrip (REV-MQGCXM34-65D7 events show
// "Onward Select button not found" + "Return Select button not found",
// yet booking still defaulted to non-picks). This rewrite tries multiple
// commit strategies in priority order and reports which (if any) fired.
// The diagnostic data appears in the run's events trace so we can refine.
//
// Strategies:
//   (a) Radio input inside row + dispatch click + change events (React-safe)
//   (b) Checkbox input inside row
//   (c) Button matching widened text: book|select|choose|pick|continue|
//       proceed|confirm|apply|use|add|done|next|go|review
//   (d) Element with role=radio
// Returns the strategy that fired (string) or 'none' if no commit control
// was found / clickable, for diagnostic logging.
async function _clickSelectInRow(page) {
  const result = await page.evaluate(() => {
    const row = document.querySelector('[data-reviewpulse="row"]');
    if (!row) return { strategy: 'none', reason: 'no-row' };
    const scopes = [row, row.parentElement].filter(Boolean);
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      const cs = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    const inProximity = (el, scope) => {
      if (scope === row) return true;
      const er = el.getBoundingClientRect();
      const rr = row.getBoundingClientRect();
      return er.top >= rr.top - 20 && er.top <= rr.bottom + 200;
    };
    // Strategy (a): radio input inside row — most common Etrav pattern.
    for (const scope of scopes) {
      const radios = Array.from(scope.querySelectorAll('input[type="radio"]'));
      for (const r of radios) {
        if (!isVisible(r) || !inProximity(r, scope)) continue;
        if (r.checked) continue; // already selected
        r.setAttribute('data-reviewpulse', 'commit-radio');
        r.click();
        r.dispatchEvent(new Event('input', { bubbles: true }));
        r.dispatchEvent(new Event('change', { bubbles: true }));
        return { strategy: 'radio', sample: (r.id || r.name || 'unnamed').slice(0, 40) };
      }
    }
    // Strategy (b): checkbox input inside row.
    for (const scope of scopes) {
      const cbs = Array.from(scope.querySelectorAll('input[type="checkbox"]'));
      for (const c of cbs) {
        if (!isVisible(c) || !inProximity(c, scope)) continue;
        if (c.checked) continue;
        c.setAttribute('data-reviewpulse', 'commit-checkbox');
        c.click();
        c.dispatchEvent(new Event('input', { bubbles: true }));
        c.dispatchEvent(new Event('change', { bubbles: true }));
        return { strategy: 'checkbox', sample: (c.id || c.name || 'unnamed').slice(0, 40) };
      }
    }
    // Strategy (c): button matching widened commit text (Book Now also accepted).
    const wideRx = /^(book(\s+now)?|select(\s+(fare|flight))?|choose(\s+(fare|flight))?|pick(\s+this(\s+fare)?)?|continue|proceed|confirm|apply|use(\s+this)?|add(\s+to(\s+trip)?)?|done|next|go|review)$/i;
    for (const scope of scopes) {
      const btns = Array.from(scope.querySelectorAll('button, a, [role="button"], [role="radio"], input[type="button"], input[type="submit"]'));
      for (const b of btns) {
        if (!isVisible(b) || !inProximity(b, scope)) continue;
        const t = (b.textContent || b.value || '').trim();
        if (!wideRx.test(t)) continue;
        b.setAttribute('data-reviewpulse', 'commit-btn');
        return { strategy: 'button', label: t.slice(0, 40) };
      }
    }
    // Diagnostic: capture what controls ARE in the row so we can refine.
    const diagBtns = [];
    for (const scope of scopes) {
      const all = Array.from(scope.querySelectorAll('button, a, [role="button"]'));
      for (const b of all) {
        if (!isVisible(b)) continue;
        const t = (b.textContent || '').trim().slice(0, 30);
        if (t) diagBtns.push(t);
        if (diagBtns.length >= 10) break;
      }
      if (diagBtns.length >= 10) break;
    }
    return { strategy: 'none', controls: diagBtns };
  }).catch((e) => ({ strategy: 'error', err: String(e).slice(0, 80) }));
  if (result.strategy === 'radio') {
    return { ok: true, strategy: 'radio', sample: result.sample };
  }
  if (result.strategy === 'checkbox') {
    return { ok: true, strategy: 'checkbox', sample: result.sample };
  }
  if (result.strategy === 'button') {
    const clicked = await _clickByMarker(page, 'commit-btn');
    return { ok: clicked, strategy: 'button', label: result.label };
  }
  return { ok: false, strategy: result.strategy || 'none', diag: result };
}

/**
 * Run one Flight-INTL review-pulse attempt against the already-loaded
 * results page.
 *
 * @param {Object} args
 *   page    — Playwright page already at /flights search-results
 *   sector  — { from, to } sector identifier (e.g. { from: 'BOM', to: 'DXB' })
 *   scenario — calling scenario for traceability
 *   maxLoadWaitMs — hard cap on full-load wait (default 120000)
 * @returns {Promise<Object>} result row
 */
async function runOnce(args) {
  const sector = args.sector || { from: '?', to: '?' };
  const routeKey = (sector.from || '?') + '->' + (sector.to || '?');
  const t0 = Date.now();
  const recT0 = args.recordStartedAt || t0; // anchor for video timeline marks
  // 2026-06-15: also mirror events + key milestone fields into args.partialResult
  // (if the parent engine passed one) so HARD_TIMEOUT in reviewPulseEngine can
  // preserve a non-empty timeline. Safe no-op if args.partialResult is absent.
  const partial = (args && args.partialResult) || null;
  const events = (partial && Array.isArray(partial.events)) ? partial.events : [];
  if (partial && !partial.events) partial.events = events;
  function tick(label, kind) { events.push({ tsMs: Date.now() - recT0, label: label, kind: kind || 'event' }); }
  const result = {
    sector:   routeKey,
    scenario: args.scenario ? (args.scenario.scenarioId || args.scenario.scenarioType) : null,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    target: null,
    metrics: null,
    verdict: null,
    severity: null,
    error: null,
    events: events,
  };

  try {
    const page = args.page;
    if (!page) throw new Error('no page handle');

    tick('Review engine started', 'load');
    tick('Waiting for Etrav results to populate', 'load');
    logger.info('[REVIEW-PULSE] waiting for full result load on ' + routeKey);
    const finalCount = await parser.waitForResultsFullyLoaded(page, { maxChecks: 50, settleAfter: 4 });
    logger.info('[REVIEW-PULSE]   stabilised at ' + finalCount + ' populated rows');
    result.populatedRowsAfterWait = finalCount;
    if (partial) partial.populatedRowsAfterWait = finalCount;
    tick('Results polling done · ' + finalCount + ' populated rows', 'load');

    // If Etrav returned 0 populated rows after the wait, that's an Etrav-side
    // issue (results never rendered for this sector). Surface as RESULTS_NOT_LOADED
    // (Etrav bucket, P1) instead of letting the throw end up as REVIEW_BROKEN.
    if (finalCount === 0) {
      result.verdict = 'RESULTS_NOT_LOADED';
      result.severity = 'P1';
      result.error = 'Etrav results page never populated any flight rows after polling';
      logger.warn('[REVIEW-PULSE] RESULTS_NOT_LOADED on ' + routeKey + ': 0 populated rows after wait');
      return result;
    }

    const combos = await parser.enumerateCombos(page);
    if (!combos || combos.length === 0) {
      // Rows existed but enumerator couldn't parse them — same product symptom for Etrav.
      result.verdict = 'RESULTS_NOT_LOADED';
      result.severity = 'P1';
      result.error = 'Etrav results visible but no parseable (airline,flight,fare) combos found';
      logger.warn('[REVIEW-PULSE] RESULTS_NOT_LOADED on ' + routeKey + ': enumerator returned 0 combos from ' + finalCount + ' rows');
      return result;
    }
    logger.info('[REVIEW-PULSE]   enumerated ' + combos.length + ' (airline,flight,fare) combos');
    tick('Enumerated ' + combos.length + ' fare combos', 'load');

    let target = picker.pick(ENGINE_KEY, routeKey, combos);
    if (!target) throw new Error('picker returned null');
    result.target = target;
    if (partial) partial.target = target;
    logger.info('[REVIEW-PULSE]   picked: ' + target.airline + ' ' + target.flightCode + ' [' + target.fareLabel + '] \u20b9' + target.price);

    // 2026-06-15: roundtrip-aware path. Etrav's roundtrip results page has
    // separate onward + return sections; the flat picker above mixes them. If
    // tripType is round-trip, classify each combo by DOM section, pick ONE
    // from each side, and remember the return for a second row+fare click
    // pass. Falls back gracefully to flat single-pick if section detection
    // fails (logs a warning but keeps the run going).
    const tripType = (args.scenario && args.scenario.tripType) || null;
    let returnTarget = null;
    let isRoundtripFlow = false;
    // 2026-06-18 (recon-confirmed): Etrav round-trip results render each flight as
    // a row with INLINE fare options + an INLINE "Book Now" on the row (combined
    // round-trip fare; fixed onward+return combo). There is NO separate onward/
    // return checkbox-commit + footer Book Now. Clicking a row's own Book Now goes
    // straight to /flights/itinerary-page. So book the SINGLE picked row via its
    // inline Book Now (same path as one-way) and verify that flight on the review
    // page. Set INLINE_ROW_BOOK=false to restore the legacy split-leg flow.
    const INLINE_ROW_BOOK = true;
    if (tripType === 'round-trip') {
      result.tripType = 'round-trip';
      // 2026-06-15: sector-based section detection. The text-marker heuristic
      // (ONWARD/RETURN walking the DOM) failed on every roundtrip in the
      // last 10 runs because Etrav's results page doesn't expose those
      // section headers. Instead, classify each card by its FIRST (IATA)
      // airport code in parens: onward cards depart from sector.from, return
      // cards depart from sector.to. Every Etrav flight card surfaces both
      // codes in the form "City (XXX)" so this is universal.
      const fromCode = (sector.from || '').toUpperCase();
      const toCode   = (sector.to   || '').toUpperCase();
      const sectionMap = await page.evaluate(({ fromCode, toCode }) => {
        function firstIata(text) {
          const codes = (text || '').match(/\(([A-Z]{3})\)/g);
          return codes && codes.length ? codes[0].slice(1, 4) : null;
        }
        function fallbackTextHeuristic(card) {
          // Original walk-up heuristic kept as fallback when IATA can't classify.
          let node = card;
          let walks = 0;
          while (node && walks < 30) {
            walks++;
            let prev = node.previousElementSibling;
            while (prev) {
              const t = ((prev.innerText || prev.textContent) || '').trim().slice(0, 150).toUpperCase();
              if (/^(ONWARD|ONGOING|OUTBOUND|DEPARTURE)/.test(t)) return 'onward';
              if (/^(RETURN|INBOUND)/.test(t)) return 'return';
              prev = prev.previousElementSibling;
            }
            const cls = (node.className || '').toString().toLowerCase();
            if (/(onward|outbound|depart)/.test(cls)) return 'onward';
            if (/(return|inbound)/.test(cls)) return 'return';
            node = node.parentElement;
          }
          return null;
        }
        const cards = Array.from(document.querySelectorAll('.accordion_container'));
        const m = {};
        for (let i = 0; i < cards.length; i++) {
          const card = cards[i];
          const txt = (card.innerText || card.textContent || '');
          const origin = firstIata(txt);
          if (origin === fromCode) { m[i] = 'onward'; continue; }
          if (origin === toCode)   { m[i] = 'return'; continue; }
          m[i] = fallbackTextHeuristic(card);
        }
        return m;
      }, { fromCode, toCode }).catch(() => ({}));
      const onwardCombos = combos.filter(c => sectionMap[c.rowIdx] === 'onward');
      const returnCombos = combos.filter(c => sectionMap[c.rowIdx] === 'return');
      logger.info('[REVIEW-PULSE]   roundtrip detected - onward=' + onwardCombos.length + ' return=' + returnCombos.length + ' unclassified=' + (combos.length - onwardCombos.length - returnCombos.length));
      tick('Roundtrip enumerate - onward=' + onwardCombos.length + ' return=' + returnCombos.length, 'load');
      if (onwardCombos.length > 0 && returnCombos.length > 0) {
        isRoundtripFlow = true;
        const onwardPick = picker.pick(ENGINE_KEY, routeKey + '#onward', onwardCombos) || onwardCombos[0];
        const returnPick = picker.pick(ENGINE_KEY, routeKey + '#return', returnCombos) || returnCombos[0];
        target = onwardPick;
        result.target = onwardPick;
        result.returnTarget = returnPick;
        if (partial) partial.target = onwardPick;
        returnTarget = returnPick;
        logger.info('[REVIEW-PULSE]   roundtrip picks: onward=' + onwardPick.airline + ' ' + onwardPick.flightCode + ' / return=' + returnPick.airline + ' ' + returnPick.flightCode);
        tick('Roundtrip picks: onward=' + onwardPick.flightCode + ' / return=' + returnPick.flightCode, 'load');
      } else {
        logger.warn('[REVIEW-PULSE]   roundtrip section split incomplete - falling back to flat pick');
        result.roundtripSectionDetection = 'failed';
        tick('Roundtrip section detect failed, flat pick', 'load');
      }
    }

    // 2026-06-18: SELECTION-DRIFT GUARD (fixes TARGET_MISMATCH, e.g.
    // REV-MQIG8ZSR-C994). Etrav keeps re-sorting / trickling GDS rows AFTER
    // enumeration, so the rowIdx captured at enumerate time can point at a
    // DIFFERENT flight by the time we click — the engine then books a flight
    // that does not match its recorded target. Re-resolve the row by the
    // picked flightCode right before clicking so we always click (and book)
    // exactly the flight we recorded as the target.
    const _resolveRowIdxByCode = async (wantFlightCode, want) => {
      const wantCode = (wantFlightCode || '').replace(/\s+/g, '').toUpperCase();
      if (!wantCode) return -1;
      try {
        return await page.evaluate(({ wantCode, fromCode, toCode, want }) => {
          const norm = (x) => (x || '').replace(/\s+/g, '').toUpperCase();
          const firstIata = (t) => { const c = (t || '').match(/\(([A-Z]{3})\)/g); return c && c.length ? c[0].slice(1, 4) : null; };
          const lineRx = /^([A-Z][A-Za-z\s\-&\.']{1,30}?)((?:[A-Z]{2}|[A-Z]\d|\d[A-Z])\s*\d{1,4})/;
          const cards = Array.from(document.querySelectorAll('.accordion_container'));
          let fallback = -1;
          for (let i = 0; i < cards.length; i++) {
            const text = ((cards[i].innerText || cards[i].textContent) || '').trim();
            if (text.length < 80) continue;
            const lines = text.split('\n').map((x) => x.trim()).filter(Boolean);
            let code = null;
            for (const ln of lines) { const m = ln.match(lineRx); if (m) { code = norm(m[2]); break; } }
            if (code !== wantCode) continue;
            if (!want) return i;
            const origin = firstIata(text);
            const section = origin === fromCode ? 'onward' : origin === toCode ? 'return' : null;
            if (section === want) return i;
            if (fallback < 0) fallback = i;
          }
          return fallback;
        }, { wantCode, fromCode: (sector.from || '').toUpperCase(), toCode: (sector.to || '').toUpperCase(), want });
      } catch (e) { logger.warn('[REVIEW-PULSE] row re-resolve failed: ' + e.message); return -1; }
    };
    {
      const reIdx = await _resolveRowIdxByCode(target.flightCode, isRoundtripFlow ? 'onward' : null);
      if (reIdx >= 0 && reIdx !== target.rowIdx) {
        tick('Onward row re-resolved by code ' + target.flightCode + ': idx ' + target.rowIdx + ' -> ' + reIdx, 'load');
        target.rowIdx = reIdx;
      } else if (reIdx < 0) {
        tick('Onward re-resolve: ' + target.flightCode + ' not found, keeping idx ' + target.rowIdx, 'load');
      }
    }

    // Mark the target row, click to expand
    await page.evaluate((rowIdx) => {
      const cards = document.querySelectorAll('.accordion_container');
      const el = cards[rowIdx];
      if (el) {
        el.setAttribute('data-reviewpulse', 'row');
        el.scrollIntoView({ block: 'center' });
      }
    }, target.rowIdx);
    tick('Results loaded · row picked', 'load');
    await page.waitForTimeout(500);
    tick('Click flight row', 'click');
    if (!await _clickByMarker(page, 'row')) {
      result.error = 'row click failed';
      const ev = evaluator.evaluate({ stage: 'BOOK_FIND' });
      result.verdict = ev.verdict; result.severity = ev.severity;
      return result;
    }
    await page.waitForTimeout(2000);

    // Click "More Fares" if present (Emirates exposes fares this way)
    const moreFaresFound = await page.evaluate(() => {
      const target = document.querySelector('[data-reviewpulse="row"]');
      if (!target) return false;
      const all = Array.from(target.querySelectorAll('*'));
      for (const el of all) {
        if (el.children.length > 0) continue;
        const t = (el.textContent || '').trim();
        if (/^more\s*fares$/i.test(t)) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) { el.setAttribute('data-reviewpulse', 'more-fares'); return true; }
        }
      }
      return false;
    }).catch(() => false);
    if (moreFaresFound) {
      tick('Click More Fares', 'click');
      await _clickByMarker(page, 'more-fares');
      await page.waitForTimeout(1500);
    }

    // Select the target fare option (best-effort — if not found, default fare still used)
    tick('Click fare option', 'click');
    await _markAndClickFareOption(page, target);
    await page.waitForTimeout(800);

    // 2026-06-16: roundtrip per-row commit. On roundtrip pages Etrav requires
    // clicking "Select" inside the row to register THIS flight as the leg's
    // chosen option (separate from the bottom summary Book Now). Without this
    // commit, the bottom Book Now uses Etrav's default highlights and books
    // a different airline than the engine picked.
    if (isRoundtripFlow && !INLINE_ROW_BOOK) {
      const r = await _clickSelectInRow(page);
      if (r.ok) {
        tick('Onward commit via ' + r.strategy + (r.label ? ' [' + r.label + ']' : r.sample ? ' [' + r.sample + ']' : ''), 'click');
        result.onwardCommit = r.strategy;
        await page.waitForTimeout(600);
      } else {
        const diagStr = r.diag && r.diag.controls ? ' visible-controls=[' + (r.diag.controls || []).join('|') + ']' : '';
        tick('Onward commit NONE (no radio/checkbox/button found)' + diagStr, 'click');
        result.onwardCommit = 'none';
        if (r.diag && r.diag.controls) result.onwardCommitDiag = r.diag.controls;
      }
    }

    // 2026-06-15: roundtrip second-leg click. After the onward row+fare have
    // been clicked, repeat the SAME mark+click+fare sequence on the return
    // target so Etrav's bottom-summary Book Now books OUR pair (not whatever
    // defaults Etrav had pre-selected).
    if (isRoundtripFlow && returnTarget && !INLINE_ROW_BOOK) {
      {
        const reIdx = await _resolveRowIdxByCode(returnTarget.flightCode, 'return');
        if (reIdx >= 0 && reIdx !== returnTarget.rowIdx) {
          tick('Return row re-resolved by code ' + returnTarget.flightCode + ': idx ' + returnTarget.rowIdx + ' -> ' + reIdx, 'load');
          returnTarget.rowIdx = reIdx;
        } else if (reIdx < 0) {
          tick('Return re-resolve: ' + returnTarget.flightCode + ' not found, keeping idx ' + returnTarget.rowIdx, 'load');
        }
      }
      await page.evaluate((rowIdx) => {
        const old = document.querySelector('[data-reviewpulse="row"]');
        if (old) old.removeAttribute('data-reviewpulse');
        const cards = document.querySelectorAll('.accordion_container');
        const el = cards[rowIdx];
        if (el) {
          el.setAttribute('data-reviewpulse', 'row');
          el.scrollIntoView({ block: 'center' });
        }
      }, returnTarget.rowIdx);
      tick('Click return row', 'click');
      await page.waitForTimeout(500);
      if (!await _clickByMarker(page, 'row')) {
        result.error = 'return row click failed';
        const ev = evaluator.evaluate({ stage: 'BOOK_FIND' });
        result.verdict = ev.verdict; result.severity = ev.severity;
        return result;
      }
      await page.waitForTimeout(2000);
      const mfReturn = await page.evaluate(() => {
        const target = document.querySelector('[data-reviewpulse="row"]');
        if (!target) return false;
        const all = Array.from(target.querySelectorAll('*'));
        for (const el of all) {
          if (el.children.length > 0) continue;
          const t = (el.textContent || '').trim();
          if (/^more\s*fares$/i.test(t)) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) { el.setAttribute('data-reviewpulse', 'more-fares'); return true; }
          }
        }
        return false;
      }).catch(() => false);
      if (mfReturn) {
        tick('Click More Fares (return)', 'click');
        await _clickByMarker(page, 'more-fares');
        await page.waitForTimeout(1500);
      }
      tick('Click return fare option', 'click');
      await _markAndClickFareOption(page, returnTarget);
      await page.waitForTimeout(800);
      const r2 = await _clickSelectInRow(page);
      if (r2.ok) {
        tick('Return commit via ' + r2.strategy + (r2.label ? ' [' + r2.label + ']' : r2.sample ? ' [' + r2.sample + ']' : ''), 'click');
        result.returnCommit = r2.strategy;
        await page.waitForTimeout(600);
      } else {
        const diagStr2 = r2.diag && r2.diag.controls ? ' visible-controls=[' + (r2.diag.controls || []).join('|') + ']' : '';
        tick('Return commit NONE (no radio/checkbox/button found)' + diagStr2, 'click');
        result.returnCommit = 'none';
        if (r2.diag && r2.diag.controls) result.returnCommitDiag = r2.diag.controls;
      }
    }

    // Find Book Now button — STRICTLY scoped to the marked row first, then
    // parent ONLY as fallback. Without the row-scope check we can pick up the
    // first Book Now button across sibling rows (different airline).
    let bookFound = await page.evaluate(() => {
      const row = document.querySelector('[data-reviewpulse="row"]');
      if (!row) return false;
      const scopes = [row, row.parentElement].filter(Boolean);
      for (const scope of scopes) {
        const btns = Array.from(scope.querySelectorAll('button'));
        for (const b of btns) {
          // For parent scope, require the button to be within (or near) the marked row
          if (scope !== row) {
            const br = b.getBoundingClientRect();
            const rr = row.getBoundingClientRect();
            // Vertical proximity: button must be inside or directly below the row card
            if (br.top < rr.top - 20 || br.top > rr.bottom + 400) continue;
          }
          const t = (b.textContent || '').trim();
          if (/^book\s*now$/i.test(t)) {
            const r = b.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) { b.setAttribute('data-reviewpulse', 'book'); return true; }
          }
        }
        // Leaf fallback: any non-button element with text "Book Now"
        const all = Array.from(scope.querySelectorAll('*'));
        for (const el of all) {
          if (el.children.length > 0) continue;
          const t = (el.textContent || '').trim();
          if (!/^book\s*now$/i.test(t)) continue;
          if (scope !== row) {
            const er = el.getBoundingClientRect();
            const rr = row.getBoundingClientRect();
            if (er.top < rr.top - 20 || er.top > rr.bottom + 400) continue;
          }
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) { el.setAttribute('data-reviewpulse', 'book'); return true; }
        }
      }
      return false;
    }).catch(() => false);
    // Roundtrip fallback: on INTL roundtrip pages Etrav puts the real Book Now
    // in a page-bottom summary bar that combines onward + return (per-row buttons
    // say "Select", not "Book Now"). When no row-scoped Book Now exists, search
    // the whole page and prefer buttons in the lower half of the viewport and/or
    // inside a sticky/fixed container.
    if (!bookFound) {
      bookFound = await page.evaluate(() => {
        const cand = [];
        const els = Array.from(document.querySelectorAll('button, a, [role="button"]'));
        for (const el of els) {
          const t = (el.textContent || '').trim();
          if (!/^book\s*now$/i.test(t)) continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const vh = window.innerHeight || 800;
          let score = 0;
          if (r.top > vh * 0.5)  score += 10;
          if (r.top > vh * 0.75) score += 10;
          let p = el.parentElement;
          while (p) {
            const pos = window.getComputedStyle(p).position;
            if (pos === 'sticky' || pos === 'fixed') { score += 20; break; }
            p = p.parentElement;
          }
          cand.push({ el: el, score: score, top: r.top });
        }
        if (cand.length === 0) return false;
        cand.sort(function(a, b) { return (b.score - a.score) || (b.top - a.top); });
        cand[0].el.setAttribute('data-reviewpulse', 'book');
        return true;
      }).catch(() => false);
      if (bookFound) {
        result.bookButtonScope = 'roundtrip-summary';
        tick('Roundtrip summary Book Now found', 'click');
      }
    }
    if (!bookFound) {
      const ev = evaluator.evaluate({ stage: 'BOOK_FIND' });
      result.verdict = ev.verdict; result.severity = ev.severity;
      result.error = 'Book Now not found (row-scoped + page-wide summary)';
      return result;
    }
    if (!result.bookButtonScope) result.bookButtonScope = 'row';

    const bookClickStart = Date.now();
    const ctx = page.context();
    const newPagePromise = ctx.waitForEvent('page', { timeout: 15000 }).catch(() => null);
    const beforeUrl = page.url();
    tick('Click Book Now', 'click');
    await _clickByMarker(page, 'book');

    // Post-Book confirmation dialog handler — Etrav shows a notification modal
    // (e.g. "airport change notice" when operating airport differs from booked
    // airport) that BLOCKS navigation until user clicks OK. Without dismissing
    // it the page never advances and we'd misclassify as BOOK_CLICK_NO_NAV.
    await page.waitForTimeout(800);
    const dialog = await page.evaluate(() => {
      const sels = ['[role="dialog"]','.modal','.dialog','.popup','[class*="modal"]','[class*="dialog"]','[class*="overlay"]'];
      const seen = new Set(); const dialogs = [];
      for (const s of sels) {
        document.querySelectorAll(s).forEach(el => {
          if (seen.has(el)) return; seen.add(el);
          const r = el.getBoundingClientRect();
          const cs = window.getComputedStyle(el);
          if (r.width === 0 || r.height === 0) return;
          if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return;
          dialogs.push(el);
        });
      }
      for (const dlg of dialogs) {
        const btns = Array.from(dlg.querySelectorAll('button, a, [role="button"]'));
        for (const b of btns) {
          const t = (b.textContent || '').trim();
          if (/^(ok|okay|continue|proceed|yes|confirm|got it|i agree|i understand)$/i.test(t)) {
            const r = b.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            b.setAttribute('data-reviewpulse', 'dialog-ok');
            return { found: true, label: t };
          }
        }
      }
      return { found: false };
    }).catch(() => ({ found: false }));
    if (dialog && dialog.found) {
      tick('Post-Book dialog dismissed (' + dialog.label + ')', 'click');
      await _clickByMarker(page, 'dialog-ok');
      result.dialogDismissed = dialog.label;
      await page.waitForTimeout(800);
    }

    const newPage = await newPagePromise;
    let reviewPage = newPage || page;
    try {
      await reviewPage.waitForLoadState('domcontentloaded', { timeout: PAGE_NAV_TIMEOUT_MS });
    } catch {
      const ev = evaluator.evaluate({ stage: 'NAV' });
      result.verdict = ev.verdict; result.severity = ev.severity;
      result.error = 'review-page load timeout';
      return result;
    }
    tick('Review page loaded', 'nav');
    await reviewPage.waitForTimeout(2000);
    if (!newPage && reviewPage.url() === beforeUrl) {
      const ev = evaluator.evaluate({ stage: 'BOOK_CLICK' });
      result.verdict = ev.verdict; result.severity = ev.severity;
      result.error = 'navigation did not occur after Book click';
      return result;
    }

    tick('Capture review-page metrics', 'capture');
    let metrics = await extractor.extract(reviewPage, bookClickStart);
    // Page-completeness retry: if the passenger form AND continue/book button
    // are both missing on the first capture, the review page navigated but
    // didn't finish rendering. Give it 10 more seconds and re-extract. If
    // still incomplete, surface as FAILED_TO_LOAD (P1) instead of letting
    // the evaluator mis-label it REVIEW_BROKEN.
    const incomplete = (m) => !m || (!m.hasPassengerForm && !m.hasContinueButton);
    if (incomplete(metrics)) {
      tick('Review page incomplete, retry +10s', 'nav');
      await reviewPage.waitForTimeout(10000);
      const retry = await extractor.extract(reviewPage, bookClickStart);
      if (retry) metrics = retry;
      tick('Re-capture review-page metrics', 'capture');
    }
    result.metrics = metrics;
    if (incomplete(metrics)) {
      // SOLD_OUT takes priority: Etrav often replaces the form with a "Flight
      // Not Available / has sold out since you made your selection" modal after
      // Book Now. That is an ETRAV availability event, not a page-load failure,
      // so tag it SOLD_OUT instead of FAILED_TO_LOAD.
      const _soldRx = /flight not available|no longer available|has sold out|sold out since you made|choose a different flight/i;
      const _b = (metrics && (metrics.reviewBodyFull || metrics.reviewBodySample)) || '';
      const _bannerHit = metrics && (metrics.errorBanners || []).some(function(x){ return _soldRx.test(x); });
      if (_soldRx.test(_b) || _bannerHit) {
        result.verdict = 'SOLD_OUT';
        result.severity = 'P2';
        result.error = 'Etrav "Flight Not Available" — fare sold out after Book Now';
        logger.warn('[REVIEW-PULSE] SOLD_OUT on ' + routeKey + ': flight no longer available after Book Now');
      } else {
        result.verdict = 'FAILED_TO_LOAD';
        result.severity = 'P1';
        result.error = 'review page never rendered passenger form / continue button after 12s';
        logger.warn('[REVIEW-PULSE] FAILED_TO_LOAD on ' + routeKey + ': passenger form + continue button absent after retry');
      }
      picker.recordPick(ENGINE_KEY, routeKey, target);
      if (newPage) { try { await newPage.close(); } catch {} }
      return result;
    }

    // Target-mismatch detection: if neither the picked airline NOR the flight
    // code appears anywhere on the review-page body, the click landed on a
    // different row. Scan the FULL body (not just the 400-char sample), the
    // collected flight-code list (multi-stop / codeshare safe), and accept an
    // IATA-prefix match (e.g. "AI" from "AI 2379") as a positive airline signal.
    const bodyForMatch      = (metrics.reviewBodyFull || metrics.reviewBodySample || '');
    const sampleLower       = bodyForMatch.toLowerCase();
    const sampleUpperNoSpc  = bodyForMatch.replace(/\s+/g, '').toUpperCase();
    const expectedAirline   = (target.airline || '').toLowerCase();
    const expectedFlightStr = (target.flightCode || '').replace(/\s+/g, '').toUpperCase();
    const expectedIata      = expectedFlightStr.slice(0, 2); // e.g. "AI" from "AI2379"
    const codesOnPage       = (metrics.allFlightCodes || []).map(c => String(c).toUpperCase());
    const airlineOk = !expectedAirline ||
                      sampleLower.indexOf(expectedAirline) !== -1 ||
                      (expectedIata && codesOnPage.some(c => c.startsWith(expectedIata)));
    const flightOk  = !expectedFlightStr ||
                      sampleUpperNoSpc.indexOf(expectedFlightStr) !== -1 ||
                      codesOnPage.indexOf(expectedFlightStr) !== -1;
    // 2026-06-16: STRICTER roundtrip validator — require FLIGHT CODE match
    // (no airline-only fallback). On roundtrip the same airline can serve
    // both legs, so airline-only fallback masks per-leg booking errors. See
    // REV-MQG9LQG6-B79F (picked QR571+QR330, booked QR4790+QR330 — onward
    // QR571 missing but "Qatar Airways" body text passed validator) and
    // REV-MQGCXM34-65D7 (picked AI2433+AI2290, booked AI2283+AI2284 — both
    // wrong but "Air India" body text passed). For one-way the existing
    // airline+IATA-prefix fallback stays (multi-stop / codeshare can show
    // alternate codes legitimately).
    let rtOnwardStrict = true, rtReturnStrict = true;
    if (isRoundtripFlow) {
      rtOnwardStrict = !!expectedFlightStr && (
        sampleUpperNoSpc.indexOf(expectedFlightStr) !== -1 ||
        codesOnPage.indexOf(expectedFlightStr) !== -1
      );
      if (returnTarget) {
        const expRet = (returnTarget.flightCode || '').replace(/\s+/g, '').toUpperCase();
        rtReturnStrict = !!expRet && (
          sampleUpperNoSpc.indexOf(expRet) !== -1 ||
          codesOnPage.indexOf(expRet) !== -1
        );
      }
    }
    // Use strict roundtrip checks when isRoundtripFlow; otherwise use one-way
    // airline/flight composite (existing behavior).
    const onewayOk = airlineOk || flightOk;
    const passOverall = (isRoundtripFlow && !INLINE_ROW_BOOK)
      ? (rtOnwardStrict && rtReturnStrict)
      : onewayOk;
    if (!passOverall) {
      result.verdict = 'TARGET_MISMATCH';
      result.severity = 'P1';
      const onwardOk = isRoundtripFlow ? rtOnwardStrict : (airlineOk || flightOk);
      const onwardStr = target.airline + ' ' + target.flightCode + ' (' + (onwardOk ? 'OK' : 'MISS') + ')';
      const returnStr = isRoundtripFlow && returnTarget
        ? ' return=' + returnTarget.airline + ' ' + returnTarget.flightCode + ' (' + (rtReturnStrict ? 'OK' : 'MISS') + ')'
        : '';
      result.error = 'review page mismatch onward=' + onwardStr + returnStr + ' got codes=' + JSON.stringify(codesOnPage);
      logger.warn('[REVIEW-PULSE] target mismatch: onward=' + onwardStr + returnStr);
    } else {
      const ev = evaluator.evaluate({ stage: 'CAPTURED', metrics });
      result.verdict = ev.verdict;
      result.severity = ev.severity;
    }

    // Record this pick into the route's ring buffer
    picker.recordPick(ENGINE_KEY, routeKey, target);
    if (isRoundtripFlow && returnTarget) {
      picker.recordPick(ENGINE_KEY, routeKey + '#return', returnTarget);
    }

    // Tidy up: close review tab if it was new
    if (newPage) { try { await newPage.close(); } catch {} }
  } catch (e) {
    result.error = e.message;
    result.verdict = evaluator.VERDICTS.REVIEW_BROKEN;
    result.severity = 'P2';
  } finally {
    result.durationMs = Date.now() - t0;
  }
  return result;
}

module.exports = { runOnce, ENGINE_KEY };
