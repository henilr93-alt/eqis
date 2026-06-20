// auditFormRecovery.js — Engine 9: self-heal a FLIGHT_FORM_NOT_LOADED stumble (ADDITIVE, Engine-9 only).
//
// PROBLEM (root-caused 2026-06-20 via the audit of run FIA-MQLDUJ8F-A60A): login
// succeeds and lands on https://new.etrav.in/flights, but PHASE A then ends up on
// the post-login ACCOUNT DASHBOARD (new.etrav.in root) where the "Where From ?" /
// "Where To ?" search inputs do not exist. The search never actually ran — an
// EQIS-side stumble, NOT an Etrav failure — yet the run is marked
// FLIGHT_FORM_NOT_LOADED (by auditReclassifier) and given up on.
//
// THIS MODULE recovers from that state so the same situation self-heals next time:
//   1. Probe the live DOM for the two flight autosuggest inputs.
//   2. If absent, CLICK the in-app "Flights" nav tab — a client-side SPA route that
//      preserves the session/referer, so it AVOIDS the server-side redirect to the
//      etrav.in marketing site that a fresh page.goto('/flights') triggers
//      (CEO Directive #2). This is exactly the "click the flight tab" the operator
//      expected the engine to do.
//   3. Wait for the form inputs to render.
//   4. As a last resort, fall back to ONE hard goto('/flights').
//
// It NEVER modifies engine3-searchpulse/* (CEO Directive #8 — engine3 is off-limits):
// it only navigates the shared page back onto the flight form. The orchestrator
// re-runs the proven engine3 search ONCE after a successful recovery (engine3 will
// SKIP its own re-goto because the URL is already /flights — flightSearchPulse.js:227).
// Bounded to a single recovery attempt; all errors are swallowed so the run always
// completes and still writes its row exactly as before if recovery fails.

const logger = require('../utils/logger');

// Canonical Etrav flight-search autosuggest inputs (same selectors engine3 + the
// reclassifier probe — flightSearchPulse.js:246-247, auditReclassifier.js:28-29).
const ORIGIN_SELECTOR = 'input[placeholder="Where From ?"]';
const DEST_SELECTOR = 'input[placeholder="Where To ?"]';
const FLIGHTS_URL = 'https://new.etrav.in/flights';

const FORM_WAIT_MS = 20000;   // how long to wait for the form to render after a nav
const GOTO_TIMEOUT_MS = 30000;

// Probe the live page for BOTH flight-search inputs. Best-effort.
async function _probeForm(page) {
  try {
    return await page.evaluate(({ originSel, destSel }) => ({
      originPresent: !!document.querySelector(originSel),
      destPresent: !!document.querySelector(destSel),
    }), { originSel: ORIGIN_SELECTOR, destSel: DEST_SELECTOR });
  } catch {
    return { originPresent: false, destPresent: false };
  }
}

// Click the in-app "Flights" nav entry (SPA route — no full reload, no redirect).
// Tries, in order: a visible anchor pointing at the /flights route, then a visible
// nav element whose text is exactly "Flight(s)". Returns { clicked, how }.
async function _clickFlightsTab(page) {
  try {
    return await page.evaluate(() => {
      function visible(el) {
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      }
      // 1) anchors whose href targets the flights route
      const anchors = Array.from(document.querySelectorAll('a[href]')).filter((a) => {
        const href = a.getAttribute('href') || '';
        return /\/flights(\b|\/|\?|$)/i.test(href) && visible(a);
      });
      if (anchors.length) { anchors[0].click(); return { clicked: true, how: 'anchor_href' }; }

      // 2) text-based nav item ("Flights" / "Flight" / "Book Flights")
      const cands = Array.from(document.querySelectorAll('a, button, li, span, div')).filter((el) => {
        const t = (el.textContent || '').trim().toLowerCase();
        return (t === 'flights' || t === 'flight' || t === 'book flights') && el.children.length <= 2 && visible(el);
      });
      if (cands.length) { cands[0].click(); return { clicked: true, how: 'text' }; }

      return { clicked: false, how: 'none' };
    });
  } catch {
    return { clicked: false, how: 'error' };
  }
}

// Attempt to recover the flight search form on the still-open page.
//
// @returns {Promise<{attempted:boolean, recovered:boolean, method:string, reason:string}>}
//   method: 'already_present' | 'flights_tab_click' | 'goto_fallback' | 'none'
async function recoverFlightForm({ page, meta }) {
  const out = { attempted: true, recovered: false, method: 'none', reason: '' };
  const sector = (meta && meta.sector) || '';
  try {
    if (!page) { out.attempted = false; out.reason = 'no_page'; return out; }

    // Already on the form? Nothing to recover.
    let probe = await _probeForm(page);
    if (probe.originPresent && probe.destPresent) {
      out.recovered = true; out.method = 'already_present'; out.reason = 'form_already_present';
      return out;
    }

    // Step 1 — click the in-app Flights tab (SPA route, avoids the Directive #2 redirect).
    const click = await _clickFlightsTab(page);
    if (click.clicked) {
      await page.waitForSelector(ORIGIN_SELECTOR, { timeout: FORM_WAIT_MS }).catch(() => {});
      probe = await _probeForm(page);
      if (probe.originPresent && probe.destPresent) {
        out.recovered = true; out.method = 'flights_tab_click'; out.reason = 'form_loaded_after_tab_click';
        logger.info('[FLIGHT-INTL-AUDIT] form recovery: Flights tab click surfaced the search form' + (sector ? ' (' + sector + ')' : ''));
        return out;
      }
    }

    // Step 2 — last resort: a single hard goto to /flights.
    try {
      await page.goto(FLIGHTS_URL, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
      await page.waitForSelector(ORIGIN_SELECTOR, { timeout: FORM_WAIT_MS }).catch(() => {});
    } catch { /* swallowed — probe below decides outcome */ }
    probe = await _probeForm(page);
    if (probe.originPresent && probe.destPresent) {
      out.recovered = true; out.method = 'goto_fallback'; out.reason = 'form_loaded_after_goto';
      logger.info('[FLIGHT-INTL-AUDIT] form recovery: goto fallback surfaced the search form' + (sector ? ' (' + sector + ')' : ''));
      return out;
    }

    out.method = click.clicked ? 'flights_tab_click' : 'goto_fallback';
    out.reason = 'form_still_absent';
    logger.warn('[FLIGHT-INTL-AUDIT] form recovery failed — search form still absent' + (sector ? ' (' + sector + ')' : ''));
    return out;
  } catch (e) {
    out.reason = 'error: ' + e.message;
    logger.warn('[FLIGHT-INTL-AUDIT] form recovery error (swallowed): ' + e.message);
    return out;
  }
}

module.exports = { recoverFlightForm, ORIGIN_SELECTOR, DEST_SELECTOR, FLIGHTS_URL };
