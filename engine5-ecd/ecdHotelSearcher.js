// ecdHotelSearcher.js — Playwright flow for ECD Hotels tab on new.etrav.in.
//
// Real ECD form layout (confirmed via 2026-05-27 recon screenshot):
//   The ECD Hotels tab is a top-nav link (with NEW badge) between DMC and
//   Contact Us. Clicking it reveals a search form titled "Eagle Crest Direct
//   Hotels — Search & Book Hotels for Selective Destinations" with fields:
//     1. Select Destination  (country dropdown — Dubai / Bali / Vietnam / Thailand)
//     2. Select City         (city dropdown — depends on destination country)
//     3. Check - In          (date picker)
//     4. Check - Out         (date picker)
//     5. Rooms & Guests      (pax dropdown)
//     6. Select Nationality  (default: India)
//     7. Search Hotel button
//
// ECD inventory exists only for the 4 destination countries above. Each country
// may expose multiple cities (e.g. Thailand → Bangkok / Phuket / Pattaya). The
// rotator gives us the country; we pick the first city the dropdown offers.
//
// ZERO IMPORTS FROM engine3-searchpulse. Reuses date + pax helpers from
// utils/etravFormHelpers.js (the date/pax controls appear identical to /hotels).

const logger = require('../utils/logger');
const screenshotter = require('../utils/screenshotter');
const { extractEcdHotels } = require('./ecdListExtractor');
const settings = require('../config/settings');
const {
  pickHotelDateRange,
  fillHotelPax,
  dismissAllOverlays,
} = require('../utils/etravFormHelpers');

/**
 * ECD-specific submit click. The shared clickSearchHotels helper only
 * scans <button> elements; ECD's "Search Hotel" trigger is sometimes
 * a <div role="button"> or anchor with custom styling. Try a broader set
 * of clickable elements with the matching label.
 */
async function clickSearchHotelEcd(page) {
  try {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(200);
  } catch { /* ignore */ }

  // IMPORTANT: native JS click on a <button> only — broader selectors picked
  // up sibling elements containing the same text and clicked the wrong one.
  // Recon (scripts/ecdReconSubmit.js) confirmed this exact pattern triggers
  // the redirect to /hotels.
  const clicked = await page.evaluate(() => {
    const re = /search\s*hotel/i;
    const buttons = Array.from(document.querySelectorAll('button'));
    const btn = buttons.find((b) => {
      if (b.offsetParent === null) return false;
      // textContent === literally "Search Hotel" — strict match, not "Search & Book Hotels"
      return re.test((b.textContent || '').trim()) && !b.disabled;
    });
    if (btn) {
      btn.scrollIntoView({ block: 'center', behavior: 'instant' });
      btn.click();
      return { ok: true, text: (btn.textContent || '').trim().slice(0, 40) };
    }
    return { ok: false, count: buttons.length };
  });

  if (!clicked.ok) {
    logger.warn('[ECD-SEARCHER] Search Hotel button not found among ' + clicked.count + ' buttons');
    return false;
  }
  logger.info('[ECD-SEARCHER] Clicked button "' + clicked.text + '"');
  return true;
}

// Etrav renamed "ECD Hotels" to "DMC Hotels" in the top nav around 2026-05-30.
// We try both labels so the engine works regardless of which one is live.
const ECD_NAV_SELECTORS = [
  'a:has-text("DMC Hotels")',
  'nav a:has-text("DMC Hotels")',
  'header a:has-text("DMC Hotels")',
  ':text-is("DMC Hotels")',
  'a:has-text("ECD Hotels")',
  'nav a:has-text("ECD Hotels")',
  'header a:has-text("ECD Hotels")',
  ':text-is("ECD Hotels")',
];

// Hotel-card selectors — confirmed by 2026-05-28 recon: results page uses
// `.listingCard` for each hotel box and shows "Showing (N) Hotels" header.
const RESULTS_READY_SELECTORS = [
  '.listingCard',
  '[class*="listingCard"]',
  '.listing-container',
];

/**
 * Navigate to ECD Hotels tab by clicking the top-nav link. Resets to /hotels
 * first so the navigation is in a known state.
 *
 * Returns { url, formReady } — formReady=true means the ECD-specific form
 * (Select Destination + Select City dropdowns) is visible.
 */
async function navigateToEcdTab(page) {
  const baseUrl = settings.ETRAV_BASE_URL.replace(/\/$/, '');
  // 2026-06-18 v4: goto /echotel DIRECTLY instead of /hotels + nav-click.
  // Recon (scripts/ecdReconCompareSubmit.js) proved direct /echotel goto
  // works reliably. The old flow (goto /hotels → click DMC link) was
  // failing because Etrav's page session intermittently landed on the
  // marketing site (etrav.in) where the DMC link navigates nowhere useful
  // (ECD_TAB_NOT_FOUND = 100% of recent broken cycles).
  // Use 'load' so the defer-loaded webpack bundles + remoteEntry.js finish
  // executing before we probe the DOM. Etrav is a module-federation React app
  // whose initial body is empty until JS hydrates.
  await page.goto(baseUrl + '/echotel', { waitUntil: 'load', timeout: 60000 });
  // Wait for React to actually render — with retry. Try 'load' navigation,
  // and if body is still empty after 40s, force a reload and try again.
  const hydrated = await page.waitForFunction(
    () => document.body && (document.body.innerText || '').trim().length > 50,
    { timeout: 40000 }
  ).then(() => true).catch(() => false);

  if (!hydrated) {
    logger.warn('[ECD-SEARCHER] React did not hydrate in 40s — forcing reload');
    await page.reload({ waitUntil: 'load', timeout: 60000 }).catch(() => {});
    await page.waitForFunction(
      () => document.body && (document.body.innerText || '').trim().length > 50,
      { timeout: 40000 }
    ).catch(() => {});
  }
  await page.waitForTimeout(1500);
  await dismissAllOverlays(page).catch(() => {});

  // 2026-06-18 v4: if direct /echotel goto already rendered the form, skip nav-clicking.
  const directHit = await page.waitForFunction(() => {
    const text = (document.body.innerText || '').toLowerCase();
    return /\/echotel/.test(window.location.pathname) &&
           text.includes('select destination') && text.includes('select city');
  }, { timeout: 8000 }).then(() => true).catch(() => false);
  if (directHit) {
    logger.info('[ECD-SEARCHER] v4: ECD form rendered via direct /echotel goto (no nav-click needed) at ' + page.url());
    return { url: page.url(), formReady: true };
  }
  logger.warn('[ECD-SEARCHER] v4: direct /echotel goto did not render form, falling back to nav-link click');

  for (const sel of ECD_NAV_SELECTORS) {
    try {
      const link = await page.$(sel);
      if (!link) continue;
      logger.info('[ECD-SEARCHER] Clicking ECD Hotels nav link (' + sel + ')');
      await link.click({ force: true });
      await page.waitForTimeout(2500);
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});

      // ECD form is identified by the two "Select Destination" + "Select City"
      // dropdowns. Wait for at least one of those labels to appear.
      const formReady = await page.waitForFunction(() => {
        const text = (document.body.innerText || '').toLowerCase();
        return text.includes('select destination') && text.includes('select city');
      }, { timeout: 15000 }).then(() => true).catch(() => false);

      if (formReady) {
        logger.info('[ECD-SEARCHER] ECD form rendered at ' + page.url());
        return { url: page.url(), formReady: true };
      }
    } catch (err) {
      logger.warn('[ECD-SEARCHER] selector ' + sel + ' failed: ' + err.message);
    }
  }

  // Fallback: scan all visible nav links for ECD-related keywords (Etrav has
  // renamed this link before — "ECD Hotels" → "DMC Hotels" — so we accept
  // any variant containing those tokens or "direct").
  try {
    const candidate = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a, button, [role="link"], [role="button"]'));
      const rx = /\b(ecd|dmc|direct|eagle\s*crest)\b/i;
      for (const a of anchors) {
        const txt = (a.textContent || '').trim();
        if (!txt || txt.length > 60) continue;
        if (!rx.test(txt)) continue;
        // Must be visible
        if (a.offsetParent === null) continue;
        // Skip obvious unrelated links
        if (/sign in|logout|profile|account/i.test(txt)) continue;
        const r = a.getBoundingClientRect();
        return { text: txt, x: r.x + r.width / 2, y: r.y + r.height / 2, href: a.href || null };
      }
      return null;
    });
    if (candidate) {
      logger.info('[ECD-SEARCHER] Fallback found nav candidate: "' + candidate.text + '" — clicking');
      await page.mouse.click(candidate.x, candidate.y);
      await page.waitForTimeout(2500);
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      const formReady = await page.waitForFunction(() => {
        const text = (document.body.innerText || '').toLowerCase();
        return text.includes('select destination') && text.includes('select city');
      }, { timeout: 15000 }).then(() => true).catch(() => false);
      if (formReady) {
        logger.info('[ECD-SEARCHER] ECD form rendered (via fallback) at ' + page.url());
        return { url: page.url(), formReady: true };
      }
    }
  } catch (e) {
    logger.warn('[ECD-SEARCHER] Fallback nav scan failed: ' + e.message);
  }

  // Diagnostic: dump body details + HTML preview + cookies AND save a
  // screenshot of the supposedly empty page so we can SEE what the agent's
  // browser is actually rendering.
  try {
    const dump = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('a, button, [role="link"], [role="button"]'));
      const totalCount = all.length;
      const allTexts = all.map(el => (el.textContent || '').trim()).filter(t => t && t.length < 60);
      const bodyLen = (document.body && document.body.innerText) ? document.body.innerText.length : 0;
      const bodyPreview = (document.body && document.body.innerText) ? document.body.innerText.slice(0, 200) : '';
      const title = document.title || '';
      const htmlPreview = (document.documentElement && document.documentElement.outerHTML) ? document.documentElement.outerHTML.slice(0, 600) : '';
      const isLoading = !!document.querySelector('[class*="loading" i], [class*="spinner" i], [class*="skeleton" i]');
      const cookieLen = document.cookie ? document.cookie.length : 0;
      return { totalCount, allTexts: allTexts.slice(0, 40), bodyLen, bodyPreview, title, htmlPreview, isLoading, cookieLen };
    });
    logger.warn('[ECD-SEARCHER] No ECD nav link matched. title="' + dump.title + '" body chars=' + dump.bodyLen + ' clickables_total=' + dump.totalCount + ' loading=' + dump.isLoading + ' cookies=' + dump.cookieLen);
    logger.warn('[ECD-SEARCHER] Body preview: ' + JSON.stringify(dump.bodyPreview));
    logger.warn('[ECD-SEARCHER] HTML preview: ' + JSON.stringify(dump.htmlPreview));
    try {
      const ts = Date.now();
      const shotPath = `/Users/henielrupaarelia/Desktop/test engine/eqis/reports/ecd-debug-empty-${ts}.png`;
      await page.screenshot({ path: shotPath, fullPage: false });
      logger.warn('[ECD-SEARCHER] Empty-page screenshot saved to ' + shotPath);
    } catch (e) {
      logger.warn('[ECD-SEARCHER] Screenshot save failed: ' + e.message);
    }
  } catch { /* ignore */ }

  return { url: page.url(), formReady: false };
}

/**
 * 2026-06-18 v3: DMC field picker for Etrav's new input+autosuggest widget.
 * Recon (scripts/ecdReconCompareSubmit.js) confirmed both Destination and
 * City are now plain text inputs with floating labels, NOT custom dropdowns:
 *   <input id="destination" name="destination" type="text">
 *   <input id="city"        name="city"        type="text" disabled>
 *
 * The previous pickDropdownOption clicks the label/container which doesn't
 * trigger React's onChange — input.value stays empty → submit fails with
 * "Destination Required / City Required" → NO_REDIRECT_TO_HOTELS.
 *
 * This helper uses the native HTMLInputElement value setter (same pattern
 * as CEO Directive #3 ACTION-1) to bypass React's synthetic event system
 * and force state commit, then clicks the matching autosuggest option.
 *
 * Returns { ok, picked, error? }.
 */
async function pickDmcInputField(page, fieldId, value, opts) {
  opts = opts || {};
  const labelText = opts.labelText || fieldId;
  logger.info('[ECD-SEARCHER-V3] Picking ' + labelText + ' (input#' + fieldId + ') → ' + value);

  // 1) Wait for the input to be present + enabled (city is disabled until dest picked)
  let inputReady = false;
  for (let i = 0; i < 20; i++) {
    inputReady = await page.evaluate((id) => {
      const el = document.getElementById(id);
      return !!el && !el.disabled && el.offsetParent !== null;
    }, fieldId).catch(() => false);
    if (inputReady) break;
    await page.waitForTimeout(300);
  }
  if (!inputReady) {
    logger.warn('[ECD-SEARCHER-V3] input#' + fieldId + ' not present/enabled after 6 s');
    return { ok: false, error: 'input-not-ready' };
  }

  // 2) Click the input to focus it (opens the autosuggest panel on focus)
  try {
    await page.click('input#' + fieldId, { delay: 50 }).catch(() => {});
    await page.waitForTimeout(400);
  } catch {}

  // 3) Use native-setter pattern to set the value AND fire React events
  //    (CEO Directive #3 final-tier pattern — bypasses React's synthetic events).
  const setResult = await page.evaluate(({ id, val }) => {
    const el = document.getElementById(id);
    if (!el) return { ok: false, reason: 'no-input' };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('keyup', { bubbles: true }));
    return { ok: true, valueNow: el.value };
  }, { id: fieldId, val: value });
  if (!setResult.ok) {
    logger.warn('[ECD-SEARCHER-V3] native-setter failed for ' + fieldId);
    return { ok: false, error: 'native-setter-failed' };
  }
  await page.waitForTimeout(1200);  // wait for autosuggest panel + filter

  // 4) Look for the matching option in the autosuggest list and click it.
  //    Etrav uses a floating list that may not have role=option — scan visible
  //    children near the input, filtered to text length < 60 to avoid clicking
  //    body chunks.
  const picked = await page.evaluate(({ val }) => {
    const norm = (s) => (s || '').trim().toLowerCase();
    const wanted = norm(val);
    const candidates = Array.from(document.querySelectorAll('li, [role="option"], [class*="option" i], [class*="suggest" i] > div, [class*="dropdown" i] li, [class*="menu" i] li, [class*="list" i] li, [class*="item" i]'));
    // Score: exact match > startsWith > includes
    let best = null, bestScore = 0;
    for (const el of candidates) {
      if (el.offsetParent === null) continue;
      const t = norm(el.textContent || '');
      if (!t || t.length > 60) continue;
      let score = 0;
      if (t === wanted) score = 3;
      else if (t.startsWith(wanted)) score = 2;
      else if (t.includes(wanted)) score = 1;
      if (score > bestScore) { best = el; bestScore = score; }
    }
    if (best) {
      best.scrollIntoView({ block: 'center' });
      best.click();
      return { ok: true, text: (best.textContent || '').trim().slice(0, 40), score: bestScore };
    }
    return { ok: false, candidateCount: candidates.length };
  }, { val: value });

  if (!picked.ok) {
    logger.warn('[ECD-SEARCHER-V3] No autosuggest option matched "' + value + '" for ' + fieldId + ' (cand=' + (picked.candidateCount || 0) + ')');
    return { ok: false, error: 'no-option-matched' };
  }

  await page.waitForTimeout(800);

  // 5) Verify the input committed by reading the final value
  const finalValue = await page.evaluate((id) => {
    const el = document.getElementById(id);
    return el ? el.value : null;
  }, fieldId).catch(() => null);
  if (!finalValue || !finalValue.toLowerCase().includes(value.toLowerCase().slice(0, 4))) {
    logger.warn('[ECD-SEARCHER-V3] input#' + fieldId + ' value did not commit (got "' + finalValue + '")');
    return { ok: false, error: 'value-not-committed', actualValue: finalValue };
  }

  logger.info('[ECD-SEARCHER-V3] OK ' + labelText + ' → picked "' + picked.text + '" (input.value="' + finalValue + '")');
  return { ok: true, picked: picked.text, value: finalValue };
}

/**
 * Open a dropdown identified by its label text ("Select Destination" /
 * "Select City" / "Select Nationality") and pick the option whose text
 * contains `match`. If match=null, picks the first option.
 *
 * Tries several common dropdown patterns:
 *   - Material-UI Select (role=button + role=listbox)
 *   - react-select (.css-... wrappers with role=combobox)
 *   - Native <select>
 */
async function pickDropdownOption(page, labelText, match) {
  logger.info('[ECD-SEARCHER] Opening dropdown "' + labelText + '" → ' + (match || 'first option'));

  // Try to click the field by label (Playwright can scope to a label-associated control)
  let clicked = false;

  // Strategy 1: click any element whose text equals or contains the label,
  // then look for the nearest interactive control beneath it.
  try {
    const opened = await page.evaluate((label) => {
      // Find the element whose text is exactly the label
      const all = Array.from(document.querySelectorAll('label, span, div'));
      const labelEl = all.find((el) => (el.textContent || '').trim().toLowerCase() === label.toLowerCase());
      if (!labelEl) return false;
      // Walk up to find a container with an input/select/button
      let container = labelEl;
      for (let i = 0; i < 6 && container; i++, container = container.parentElement) {
        const trig = container.querySelector('input, [role="combobox"], [role="button"], select, .MuiSelect-select');
        if (trig) {
          trig.click();
          return true;
        }
      }
      return false;
    }, labelText);
    clicked = opened;
  } catch { /* ignore */ }

  // Strategy 2: fallback — click the placeholder text directly
  if (!clicked) {
    for (const sel of [
      `text="${labelText}"`,
      `[placeholder="${labelText}"]`,
      `[aria-label="${labelText}"]`,
    ]) {
      try {
        const el = await page.$(sel);
        if (el) { await el.click({ force: true }); clicked = true; break; }
      } catch { /* try next */ }
    }
  }

  if (!clicked) {
    logger.warn('[ECD-SEARCHER] Could not open dropdown "' + labelText + '"');
    return { opened: false, picked: null };
  }

  // Wait up to 2.5s for the dropdown menu to actually render its options
  await page.waitForTimeout(400);

  // Try a sequence of selectors from most-specific to most-generic.
  // ECD dropdowns appear to be plain <li> in a list panel (no ARIA roles),
  // so a generic fallback is required.
  const OPTION_SELECTORS = [
    '[role="option"]',
    'li.MuiMenuItem-root',
    '[class*="option"][role="option"]',
    '[class*="select__option"]',
    '.dropdown-item',
    // ECD-specific fallbacks: floating list-panel items
    '[class*="menu"] li',
    '[class*="dropdown"] li',
    'ul[class*="list"] li',
    // Catch-all: any newly-rendered <li> visible on screen
    'li',
  ];

  // Try each selector with a small wait between, to allow the menu to settle.
  let options = [];
  let usedSelector = null;
  for (let attempt = 0; attempt < 4 && options.length === 0; attempt++) {
    await page.waitForTimeout(400);
    const probe = await page.evaluate((sels) => {
      for (const sel of sels) {
        const items = Array.from(document.querySelectorAll(sel))
          .filter((el) => {
            // Must be visible
            if (el.offsetParent === null) return false;
            const text = (el.textContent || '').trim();
            // Must have short, label-like text (countries are short)
            if (text.length < 2 || text.length > 80) return false;
            // Skip elements that contain other interactive elements
            if (el.querySelector('a, button, input, select')) return false;
            return true;
          });
        if (items.length > 0 && items.length < 100) {
          return {
            selector: sel,
            items: items.map((el, idx) => ({ idx, text: el.textContent.trim() })),
          };
        }
      }
      return { selector: null, items: [] };
    }, OPTION_SELECTORS);
    if (probe.items.length > 0) {
      options = probe.items.map((it) => ({ ...it, selector: probe.selector }));
      usedSelector = probe.selector;
      break;
    }
  }

  if (options.length === 0) {
    logger.warn('[ECD-SEARCHER] Dropdown "' + labelText + '" opened but no options visible');
    return { opened: true, picked: null, optionsSeen: 0 };
  }

  logger.info('[ECD-SEARCHER] Dropdown "' + labelText + '" has ' + options.length + ' options: ' +
    options.slice(0, 6).map((o) => o.text).join(' | '));

  // Pick the option. `match` semantics:
  //   null/undefined  -> pick first
  //   { exact: 'x' }  -> pick by exact text equality (case-insensitive)
  //   string          -> pick first option whose text contains the string
  let pickIdx = 0;
  if (match && typeof match === 'object' && match.exact) {
    const m = String(match.exact).toLowerCase().trim();
    const found = options.findIndex((o) => o.text.toLowerCase().trim() === m);
    if (found >= 0) pickIdx = found;
    else logger.warn('[ECD-SEARCHER] No option equals "' + match.exact + '" — picking first');
  } else if (match) {
    const m = String(match).toLowerCase();
    const found = options.findIndex((o) => o.text.toLowerCase().includes(m));
    if (found >= 0) pickIdx = found;
    else logger.warn('[ECD-SEARCHER] No option contains "' + match + '" — picking first');
  }

  const chosen = options[pickIdx];
  const handles = await page.$$(chosen.selector);
  if (!handles[chosen.idx]) {
    logger.warn('[ECD-SEARCHER] Option handle lost between read and click');
    return { opened: true, picked: null };
  }
  await handles[chosen.idx].click({ force: true });
  await page.waitForTimeout(700);
  logger.info('[ECD-SEARCHER] Picked "' + chosen.text + '" for "' + labelText + '"');
  return { opened: true, picked: chosen.text, optionsSeen: options.length, allOptions: options.map(o => o.text) };
}

/**
 * Discover the list of cities available for a destination country on the
 * ECD form, WITHOUT submitting the form. Used to drive multi-city iteration.
 * Returns { destination, cities: [], error? }.
 */
async function listCitiesForDestination(page, destination) {
  logger.info('[ECD-DISCOVER] Starting city discovery for ' + destination);
  try {
    const nav = await navigateToEcdTab(page);
    if (!nav.formReady) {
      logger.warn('[ECD-DISCOVER] ECD form did not render for ' + destination + ' (url: ' + nav.url + ')');
      return { destination, cities: [], error: 'ECD form did not render' };
    }
    const destPick = await pickDropdownOption(page, 'Select Destination', destination);
    if (!destPick.opened || !destPick.picked) {
      logger.warn('[ECD-DISCOVER] Destination dropdown failed for ' + destination + ' (opened=' + destPick.opened + ' picked=' + destPick.picked + ')');
      return { destination, cities: [], error: 'Destination dropdown failed' };
    }
    // Open the city dropdown — pass a guaranteed-non-matching token so it
    // picks the first city as a side-effect, and we read allOptions for the
    // real city list.
    const cityRead = await pickDropdownOption(page, 'Select City', '__NEVER_MATCHES__');
    const cities = (cityRead && cityRead.allOptions) ? cityRead.allOptions : [];
    logger.info('[ECD-DISCOVER] ' + destination + ' discovered ' + cities.length + ' cities: ' + cities.join(' | '));
    return { destination, cities, error: cities.length === 0 ? 'City dropdown empty' : null };
  } catch (err) {
    logger.warn('[ECD-DISCOVER] ' + destination + ' threw: ' + err.message);
    return { destination, cities: [], error: err.message };
  }
}

async function waitForResults(page, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // Require the actual hotel boxes to be rendered. Header text can appear
    // before the boxes finish loading, so we only count real .listingCard
    // elements with hotel-name text inside (not skeleton placeholders).
    const realCards = await page.evaluate((sels) => {
      let realCount = 0;
      for (const s of sels) {
        const els = document.querySelectorAll(s);
        for (const el of els) {
          const txt = (el.textContent || '').trim();
          // A real card has > 50 chars of text (name + address + price etc).
          // Skeleton placeholders have empty text content.
          if (txt.length > 50) realCount++;
        }
      }
      return realCount;
    }, RESULTS_READY_SELECTORS);

    if (realCards > 0) {
      // Give a small extra wait so prices/names finish painting
      await page.waitForTimeout(2000);
      return true;
    }

    // Bail early if validation errors prevent results
    const hasValidationError = await page.evaluate(() => {
      return /Check-?in.*required|Check-?out.*required|destination.*required|city.*required/i
        .test(document.body.innerText || '');
    }).catch(() => false);
    if (hasValidationError && Date.now() - start > 4000) return false;

    await page.waitForTimeout(500);
  }
  return false;
}

/**
 * Run one ECD search for one destination country.
 */
async function searchEcdDestination(page, opts) {
  const { destination, checkin, checkout, adults, rooms, runId } = opts;

  const result = {
    destination,
    checkin,
    checkout,
    adults,
    rooms,
    searchStatus: 'PENDING',
    hotels: [],
    loadTimeMs: 0,
    error: null,
    screenshotPath: null,
    selectedDestination: null,
    selectedCity: null,
    pageUrl: null,
  };

  const t0 = Date.now();
  try {
    const nav = await navigateToEcdTab(page);
    result.pageUrl = nav.url;
    if (!nav.formReady) {
      result.searchStatus = 'ECD_TAB_NOT_FOUND';
      result.error = 'ECD form did not render after clicking "ECD Hotels" nav link';
      return result;
    }

    // 1) Select Destination (country) — v3 uses input+autosuggest helper first.
    //    2026-06-18: Etrav widget changed from custom dropdown to input#destination.
    let destPickResult = await pickDmcInputField(page, 'destination', destination, { labelText: 'Select Destination' });
    if (!destPickResult.ok) {
      // Fallback to legacy custom-dropdown picker in case Etrav reverts widget.
      logger.warn('[ECD-SEARCHER] v3 destination picker failed (' + destPickResult.error + ') — falling back to legacy pickDropdownOption');
      const destPick = await pickDropdownOption(page, 'Select Destination', destination);
      if (!destPick.opened || !destPick.picked) {
        result.searchStatus = 'DESTINATION_DROPDOWN_FAILED';
        result.error = 'Could not open or pick "Select Destination" (v3=' + destPickResult.error + ', legacy=opened:' + destPick.opened + '/picked:' + destPick.picked + ')';
        return result;
      }
      result.selectedDestination = destPick.picked;
    } else {
      result.selectedDestination = destPickResult.picked;
    }

    // 2) Select City — same v3 path. City field starts disabled until destination commits.
    const cityValue = opts.city || '';
    let cityPickResult = cityValue ? await pickDmcInputField(page, 'city', cityValue, { labelText: 'Select City' }) : { ok: false, error: 'no-city-specified' };
    if (!cityPickResult.ok) {
      logger.warn('[ECD-SEARCHER] v3 city picker failed (' + cityPickResult.error + ') — falling back to legacy pickDropdownOption');
      const cityMatcher = opts.city ? { exact: opts.city } : null;
      const cityPick = await pickDropdownOption(page, 'Select City', cityMatcher);
      if (!cityPick.opened || !cityPick.picked) {
        result.searchStatus = 'CITY_DROPDOWN_FAILED';
        result.error = 'Could not open or pick "Select City" (v3=' + cityPickResult.error + ', legacy=opened:' + cityPick.opened + '/picked:' + cityPick.picked + ')';
        return result;
      }
      result.selectedCity = cityPick.picked;
    } else {
      result.selectedCity = cityPickResult.picked;
    }

    // URL guard helper — confirms we're still on the ECD form between steps.
    // The earlier failure (page ending on /dashboard before submit) means one
    // of the form-filler helpers caused unintended navigation. This guard
    // pinpoints which step drifts us away.
    const assertOnEcd = async (stepName) => {
      const cur = page.url();
      if (!/\/echotel/.test(cur)) {
        result.searchStatus = 'PAGE_DRIFT_' + stepName.toUpperCase();
        result.error = 'Page navigated away from /echotel during step "' + stepName + '" — landed at ' + cur;
        logger.warn('[ECD-SEARCHER] DRIFT after ' + stepName + ': ' + cur);
        return false;
      }
      return true;
    };

    // 3) Dates — do NOT scroll the form first. Recon (ecdReconSubmit.js) proved
    //    the helper works at the page's default scroll position. An earlier
    //    attempt to scroll the form to top broke the calendar (pushing the
    //    popup off-screen).
    const datesOk = await pickHotelDateRange(page, new Date(checkin), new Date(checkout));
    if (!datesOk) {
      result.searchStatus = 'DATE_PICKER_FAILED';
      result.error = 'Could not fill check-in / check-out dates';
      return result;
    }
    if (!(await assertOnEcd('after-dates'))) return result;

    // 4) Pax + rooms (skip if defaults already match — ECD default is 1R/2A which
    //    matches our standard scenario, and the existing pax helper has been
    //    observed to cause page drift on ECD). We only call it if the requested
    //    pax differs from the visible default.
    const paxDefaultMatches = await page.evaluate(() => {
      const text = (document.body.innerText || '').toLowerCase();
      return text.includes('1 room') && text.includes('2 guests');
    }).catch(() => false);

    if (!(rooms === 1 && adults === 2 && paxDefaultMatches)) {
      const roomPax = Array.from({ length: rooms }, () => ({
        adults: Math.max(1, Math.ceil(adults / rooms)),
        children: [],
      }));
      await fillHotelPax(page, rooms, roomPax).catch((e) => {
        logger.warn('[ECD-SEARCHER] fillHotelPax warning (continuing): ' + e.message);
      });
      if (!(await assertOnEcd('after-pax'))) return result;
    } else {
      logger.info('[ECD-SEARCHER] Skipping pax fill — ECD defaults already match (1R/2A)');
    }

    // 5) Submit on /echotel — this REDIRECTS to /hotels (it's not the final search,
    //    it's the trigger that activates ECD mode on the /hotels page).
    const submitted = await clickSearchHotelEcd(page);
    if (!submitted) {
      result.searchStatus = 'SUBMIT_BUTTON_NOT_FOUND';
      result.error = '"Search Hotel" button not found on ECD form (final url: ' + page.url() + ')';
      return result;
    }
    logger.info('[ECD-SEARCHER] Submitted /echotel form: ' + result.selectedDestination + ' / ' + result.selectedCity);

    // 5b) Wait for the redirect to /hotels/search-results — the ECD form submit
    //     navigates directly there with all parameters in the URL, including
    //     isExtranet=true which is Etrav's ECD-mode flag. NO further form-filling
    //     is required — results render based on URL params.
    let redirected = await page.waitForFunction(() =>
      /\/hotels(\/search-results)?/.test(window.location.pathname) &&
      !/\/echotel/.test(window.location.pathname),
      { timeout: 20000 }
    ).then(() => true).catch(() => false);

    // 2026-06-18 v2: enhanced submit-no-nav recovery. v1 (Esc + reclick)
    // shipped earlier today, but cycle ECD-20260618-0200 proved it doesn't
    // work — 15/15 cities triggered the recovery and 0/15 succeeded. The
    // submit click registers but Etrav silently rejects the navigation
    // (no error banner, no modal). Stronger recovery in 2 escalating tiers:
    //   TIER A: Esc x3 + neutral click + reclick (cheap retry)
    //   TIER B: full page reload of /echotel + refill destination/city/dates
    //          + reclick (heavy but works when page state is corrupted)
    // Diagnostic screenshot captured on each failure so we can see what's
    // actually on screen during the silent rejection.
    if (!redirected) {
      logger.warn('[ECD-SEARCHER] First submit did not redirect — TIER A recovery (Esc + reclick) for ' + result.selectedDestination + ' / ' + result.selectedCity);
      // Diagnostic screenshot of the stuck-on-echotel state
      try {
        const shotPath = require('path').join(__dirname, '..', 'reports', 'ecd-no-redirect-' + Date.now() + '.png');
        await page.screenshot({ path: shotPath, fullPage: false }).catch(() => {});
        logger.info('[ECD-SEARCHER] No-redirect diagnostic shot: ' + shotPath);
      } catch {}
      try {
        for (let i = 0; i < 3; i++) {
          await page.keyboard.press('Escape').catch(() => {});
          await page.waitForTimeout(200);
        }
        await page.mouse.click(8, 8).catch(() => {});
        await page.waitForTimeout(600);
        const reSubmit = await clickSearchHotelEcd(page);
        if (reSubmit) {
          redirected = await page.waitForFunction(() =>
            /\/hotels(\/search-results)?/.test(window.location.pathname) &&
            !/\/echotel/.test(window.location.pathname),
            { timeout: 20000 }
          ).then(() => true).catch(() => false);
          if (redirected) {
            logger.info('[ECD-SEARCHER] TIER A recovery succeeded — redirected on 2nd attempt');
          }
        }
      } catch (e) {
        logger.warn('[ECD-SEARCHER] TIER A recovery threw: ' + e.message);
      }
    }

    // TIER B: full reload + refill if TIER A also failed.
    if (!redirected) {
      logger.warn('[ECD-SEARCHER] TIER A failed — TIER B recovery (reload /echotel + refill form) for ' + result.selectedDestination + ' / ' + result.selectedCity);
      try {
        await page.goto('https://new.etrav.in/echotel', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(2500);
        // Refill destination
        const destReload = await pickDropdownOption(page, 'Select Destination', destination);
        if (!destReload.opened || !destReload.picked) {
          logger.warn('[ECD-SEARCHER] TIER B: destination dropdown failed after reload');
        } else {
          // Refill city
          const cityReload = await pickDropdownOption(page, 'Select City', opts.city ? { exact: opts.city } : null);
          if (!cityReload.opened || !cityReload.picked) {
            logger.warn('[ECD-SEARCHER] TIER B: city dropdown failed after reload');
          } else {
            // Refill dates
            const dateReload = await pickHotelDateRange(page, new Date(checkin), new Date(checkout));
            if (!dateReload) {
              logger.warn('[ECD-SEARCHER] TIER B: date picker failed after reload');
            } else {
              // Submit again
              const submit3 = await clickSearchHotelEcd(page);
              if (submit3) {
                redirected = await page.waitForFunction(() =>
                  /\/hotels(\/search-results)?/.test(window.location.pathname) &&
                  !/\/echotel/.test(window.location.pathname),
                  { timeout: 25000 }
                ).then(() => true).catch(() => false);
                if (redirected) {
                  logger.info('[ECD-SEARCHER] TIER B recovery succeeded — redirected after full reload + refill');
                }
              } else {
                logger.warn('[ECD-SEARCHER] TIER B: 3rd submit click failed');
              }
            }
          }
        }
      } catch (e) {
        logger.warn('[ECD-SEARCHER] TIER B recovery threw: ' + e.message);
      }
    }

    if (!redirected) {
      result.searchStatus = 'NO_REDIRECT_TO_HOTELS';
      result.error = 'Submit on /echotel did not redirect to /hotels after 3 attempts (TIER A + TIER B reload+refill, still at ' + page.url() + ')';
      return result;
    }
    result.pageUrl = page.url();
    logger.info('[ECD-SEARCHER] Redirected to ' + page.url());

    // 6) Wait for ECD result cards to render on /hotels/search-results
    const ok = await waitForResults(page, 120000);
    if (!ok) {
      result.searchStatus = 'NO_RESULTS_RENDERED';
      result.error = 'ECD result cards did not render within timeout';
    } else {
      const hotels = await extractEcdHotels(page, settings.ECD_TOP_COMBOS_PER_HOTEL);
      result.hotels = hotels;
      result.searchStatus = hotels.length > 0 ? 'OK' : 'ZERO_RESULTS';
    }
  } catch (err) {
    result.searchStatus = 'ERROR';
    result.error = err.message;
    logger.error('[ECD-SEARCHER] Error for ' + destination + ': ' + err.message);
  } finally {
    result.loadTimeMs = Date.now() - t0;
    try {
      const shot = await screenshotter.takeStep(page, runId, 'ecd-' + destination.replace(/\s+/g, '_'));
      if (shot) result.screenshotPath = shot;
    } catch { /* ignore */ }
  }

  return result;
}

module.exports = {
  searchEcdDestination,
  navigateToEcdTab,
  pickDropdownOption,
  listCitiesForDestination,
  _ECD_NAV_SELECTORS: ECD_NAV_SELECTORS,
};
