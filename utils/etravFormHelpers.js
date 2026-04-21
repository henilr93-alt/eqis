// Etrav-specific form interaction helpers.
// Based on DOM inspection: Etrav uses react-autosuggest for cities and
// react-datepicker for dates. Both require specific interaction patterns.

const logger = require('./logger');
/**
 * Dismiss all open overlays — calendars, dropdowns, popups, modals.
 * Call this between form steps to ensure nothing blocks the next interaction.
 */
async function dismissAllOverlays(page) {
  // STRATEGY 1: Press Escape to close keyboard-dismissable overlays
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(200);

  // STRATEGY 2: Forcefully hide ALL overlay-like elements via JS
  await page.evaluate(() => {
    const selectors = [
      '.react-datepicker__tab-loop', '.react-datepicker-popper', '.react-datepicker',
      '.react-responsive-modal-root', '.react-responsive-modal-container',
      '.react-responsive-modal-overlay',
      '[class*="popup"]', '[class*="dropdown"][class*="open"]',
      '[class*="overlay"]', '[class*="modal"][class*="show"]',
      '[role="dialog"]', '[role="tooltip"]', '[aria-hidden="false"][class*="modal"]'
    ];
    for (const sel of selectors) {
      try {
        document.querySelectorAll(sel).forEach(el => {
          // Skip critical app roots
          if (el.id === 'root' || el.id === 'portal-root') return;
          // For datepicker poppers, hide rather than remove (Etrav's React may re-create)
          if (el.classList && el.classList.contains('react-datepicker-popper')) {
            el.style.display = 'none';
          } else {
            el.remove();
          }
        });
      } catch {}
    }
    window.scrollTo(0, 0);
  }).catch(() => {});

  // STRATEGY 3: Click on a neutral safe area (top-left of form area, NOT dropdown zone)
  await page.mouse.click(100, 100).catch(() => {});
  await page.waitForTimeout(300);

  // STRATEGY 4: One more Escape for any dropdowns that just opened
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(200);
}



/**
 * Fill a react-autosuggest city input and select the first suggestion.
 * Returns true on success.
 */
async function fillAutosuggest(page, placeholder, cityText) {
  const input = await page.$(`input[placeholder="${placeholder}"]`);
  if (!input) {
    logger.warn(`[FORM] Autosuggest input not found: ${placeholder}`);
    return false;
  }

  // Try typing the text, waiting for FRESH suggestions, then VERIFY match
  for (let attempt = 0; attempt < 3; attempt++) {
    // FIX 4: Use fill('') for cleanest React state reset — triggers proper input/change events
    await input.click({ force: true });
    await page.waitForTimeout(300);
    await input.fill('');
    await page.waitForTimeout(300);

    // FIX 1: Wait for old suggestions to disappear after clearing
    await page.waitForFunction(() => {
      return document.querySelectorAll('.react-autosuggest__suggestion').length === 0;
    }, { timeout: 3000 }).catch(() => {});

    // Type the city/airport text — 150ms delay for Etrav's React input
    await input.type(cityText, { delay: 150 });

    // FIX 2: Wait LONGER (1500ms) for Etrav's debounced API call to return fresh suggestions
    await page.waitForTimeout(1500);

    // Wait for suggestions to appear
    try {
      await page.waitForSelector('.react-autosuggest__suggestion--first, .react-autosuggest__suggestions-list .react-autosuggest__suggestion', { timeout: 8000 });
    } catch { /* no suggestions */ }

    // Additional wait for suggestion list to fully populate (not just 1-2 items)
    await page.waitForTimeout(500);

    // Try to find a suggestion that contains the target code
    // CRITICAL FIX: use Playwright's REAL click (mousedown/mouseup events) on the
    // suggestion element rather than JS .click() inside page.evaluate. The JS-only
    // click doesn't trigger all the React synthetic events that react-autosuggest
    // needs to COMMIT the selection. Result with JS click: the input shows the
    // typed text but React state is uncommitted — when the next form action
    // (date picker) causes a re-render, the input reverts to empty.
    const targetCode = cityText.toUpperCase();
    // Find the matching suggestion's index
    const suggestionIndex = await page.evaluate((code) => {
      const suggestions = document.querySelectorAll('.react-autosuggest__suggestion');
      for (let i = 0; i < suggestions.length; i++) {
        const text = (suggestions[i].textContent || '').toUpperCase();
        if (text.includes('(' + code + ')') || text.includes(code)) return i;
      }
      // Fallback: first suggestion
      return suggestions.length > 0 ? 0 : -1;
    }, targetCode);

    let matchedSuggestion = { clicked: false };
    if (suggestionIndex >= 0) {
      // Click via Playwright (real mouse events) so react-autosuggest commits
      const suggestionEls = await page.$$('.react-autosuggest__suggestion');
      if (suggestionEls[suggestionIndex]) {
        try {
          await suggestionEls[suggestionIndex].click({ force: true, timeout: 5000 });
          matchedSuggestion = { clicked: true };
        } catch {
          // Fallback to bounding-box mouse click
          try {
            const box = await suggestionEls[suggestionIndex].boundingBox();
            if (box) {
              await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
              matchedSuggestion = { clicked: true };
            }
          } catch {}
        }
      }
    }

    if (!matchedSuggestion.clicked) {
      if (attempt < 2) logger.warn(`[FORM] Autosuggest attempt ${attempt + 1}: no suggestions for "${cityText}"`);
      continue;
    }

    await page.waitForTimeout(500);

    // VERIFY: read back the input value and check it contains the target code
    const selectedValue = await page.evaluate((sel) => {
      const inp = document.querySelector(`input[placeholder="${sel}"]`);
      return inp ? inp.value : '';
    }, placeholder);

    if (selectedValue.toUpperCase().includes(targetCode)) {
      // CRITICAL FIX (search 21881): wait for the autosuggest dropdown panel to
      // FULLY close before returning. Etrav's React component is fragile — if
      // the next form step (date click) fires while the panel is mid-close,
      // Etrav's React error boundary throws "Oops! Something went wrong" and
      // unmounts the form. 21881 (CCU→BOM round-trip) crashed exactly this way.
      try {
        await page.waitForFunction(() => {
          const panel = document.querySelector('.react-autosuggest__suggestions-container--open');
          return !panel;
        }, { timeout: 3000 });
      } catch {}
      // Extra settling time for Etrav's debounced state commit (slide-out
      // animation runs ~300ms after container is gone; React state ~500ms).
      await page.waitForTimeout(800);
      logger.info(`[FORM] Autosuggest "${placeholder}": selected "${selectedValue}" for "${cityText}"`);
      return true;
    }

    // Mismatch — the wrong city was selected
    logger.warn(`[FORM] Autosuggest mismatch: wanted "${cityText}" but got "${selectedValue}" — retrying`);
  }

  logger.warn(`[FORM] Autosuggest failed for "${cityText}" in "${placeholder}" after 3 attempts`);
  return false;
}

/**
 * Fast page-health probe: did Etrav render its "Oops! Something went wrong"
 * crash page? Returns true if so. Used between form-fill steps to bail out
 * early instead of continuing to click on a crashed form.
 */
async function isFormCrashed(page) {
  try {
    return await page.evaluate(() => {
      const t = document.body.innerText || '';
      return /Oops!\s*Something went wrong|An unexpected error occurred/i.test(t);
    });
  } catch {
    return false;
  }
}

/**
 * Open a react-datepicker and select a specific date.
 * wrapperIndex: 0 = departure, 1 = return
 * targetDate: JavaScript Date object
 * Returns true on success.
 */
async function pickReactDate(page, wrapperIndex, targetDate) {
  const wrappers = await page.$$('.react-datepicker-wrapper');
  if (!wrappers[wrapperIndex]) {
    logger.warn(`[FORM] Date picker wrapper #${wrapperIndex} not found`);
    return false;
  }

  // Click to open calendar
  await wrappers[wrapperIndex].click({ force: true });
  await page.waitForTimeout(800);

  // Build aria-label format used by react-datepicker:
  // "Choose Friday, April 10th, 2026"
  const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  const weekday = weekdays[targetDate.getDay()];
  const month = months[targetDate.getMonth()];
  const day = targetDate.getDate();
  const year = targetDate.getFullYear();

  const daySuffix = (d) => {
    if (d >= 11 && d <= 13) return 'th';
    const last = d % 10;
    return last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th';
  };
  const ariaLabel = `Choose ${weekday}, ${month} ${day}${daySuffix(day)}, ${year}`;

  // Navigate to correct month if necessary (max 18 clicks forward)
  for (let nav = 0; nav < 18; nav++) {
    // Check if the target day is visible and clickable
    const dayEl = await page.$(`.react-datepicker__day[aria-label="${ariaLabel}"]:not(.react-datepicker__day--disabled)`);
    if (dayEl) {
      await dayEl.click({ force: true });
      await page.waitForTimeout(500);
      // Dismiss the calendar after date selection — press Escape + click outside
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      // Check if calendar is still open and force-close
      const calendarStillOpen = await page.$('.react-datepicker');
      if (calendarStillOpen) {
        await page.mouse.click(640, 180); // click neutral area
        await page.waitForTimeout(300);
      }
      return true;
    }

    // Check current visible month header
    const header = await page.$('.react-datepicker__current-month, .react-datepicker__header');
    if (!header) break;

    // Click "Next Month"
    const nextBtn = await page.$('.react-datepicker__navigation--next');
    if (!nextBtn) break;
    await nextBtn.click({ force: true });
    await page.waitForTimeout(300);
  }

  logger.warn(`[FORM] Could not find date ${ariaLabel} in calendar after 18 forward navigations`);
  return false;
}


/**
 * Pick flight Departure AND Return dates on Etrav's roundtrip calendar.
 * Etrav's roundtrip calendar is a SINGLE range picker that shows 2 months —
 * click departure date first, then click return date in the SAME open calendar.
 * Trying to close+reopen between picks (like pickReactDate does) breaks because
 * the calendar stays open after departure click.
 */
async function pickFlightDateRange(page, depDate, retDate) {
  const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  const daySuffix = (d) => {
    if (d >= 11 && d <= 13) return 'th';
    const last = d % 10;
    return last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th';
  };
  const buildAria = (date) =>
    `Choose ${weekdays[date.getDay()]}, ${months[date.getMonth()]} ${date.getDate()}${daySuffix(date.getDate())}, ${date.getFullYear()}`;

  // Helper: navigate months and click a target day in the OPEN calendar.
  // Uses 3-strategy click + scrollIntoView like the hotel version.
  const clickDay = async (ariaLabel) => {
    for (let nav = 0; nav < 18; nav++) {
      const el = await page.$(`.react-datepicker__day[aria-label="${ariaLabel}"]:not(.react-datepicker__day--disabled)`);
      if (el) {
        // Wait for stable bounding box
        await page.waitForFunction((label) => {
          const day = document.querySelector(`.react-datepicker__day[aria-label="${label}"]:not(.react-datepicker__day--disabled)`);
          if (!day) return false;
          const rect = day.getBoundingClientRect();
          return rect.width > 5 && rect.height > 5;
        }, ariaLabel, { timeout: 5000 }).catch(() => {});

        const fresh = await page.$(`.react-datepicker__day[aria-label="${ariaLabel}"]:not(.react-datepicker__day--disabled)`);
        const target = fresh || el;

        await target.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(200);

        let clicked = false;
        try {
          await target.click({ force: true, timeout: 5000 });
          clicked = true;
        } catch {}
        if (!clicked) {
          try {
            const box = await target.boundingBox();
            if (box && box.width > 0) {
              await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
              clicked = true;
            }
          } catch {}
        }
        if (!clicked) {
          try {
            await target.evaluate(e => { e.scrollIntoView({ block: 'center' }); e.click(); });
            clicked = true;
          } catch {}
        }
        if (clicked) {
          await page.waitForTimeout(500);
          return true;
        }
        return false;
      }
      const next = await page.$('.react-datepicker__navigation--next');
      if (!next) return false;
      await next.click({ force: true });
      await page.waitForTimeout(300);
    }
    return false;
  };

  // Force-close calendar after both dates selected
  const forceCloseCalendar = async () => {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    if (await page.$('.react-datepicker')) {
      await page.mouse.click(640, 50);
      await page.waitForTimeout(300);
    }
    if (await page.$('.react-datepicker')) {
      await page.evaluate(() => {
        document.querySelectorAll('.react-datepicker__tab-loop, .react-datepicker-popper, .react-datepicker').forEach(el => {
          el.style.display = 'none';
        });
      }).catch(() => {});
      await page.waitForTimeout(200);
    }
  };

  // Step 1: Click the Departure wrapper to open the range picker
  // BUG FIX: was `page.$` (singular) returning a single ElementHandle (not array),
  // so `wrappers[0]` was always undefined and this function returned false silently
  // for EVERY round-trip search. Use `page.$$` to get the array of all wrappers.
  const wrappers = await page.$$('.react-datepicker-wrapper');
  if (!wrappers[0]) {
    logger.warn('[FORM] Flight Departure date wrapper not found');
    return false;
  }
  await wrappers[0].click({ force: true });
  await page.waitForTimeout(1000);

  // Verify calendar opened
  if (!(await page.$('.react-datepicker'))) {
    logger.warn('[FORM] Flight date picker did not open');
    return false;
  }

  // Step 2: Click departure date in the open calendar
  const depOk = await clickDay(buildAria(depDate));
  if (!depOk) {
    logger.warn(`[FORM] Could not click flight departure: ${buildAria(depDate)}`);
    await forceCloseCalendar();
    return false;
  }
  logger.info('[FORM] Flight departure date clicked: ' + depDate.toDateString());

  // Step 3: Wait for the range picker to update its state after departure click
  // The calendar STAYS OPEN — Etrav now expects the return date click in the same calendar
  await page.waitForTimeout(700);

  // Step 4: Click return date in the SAME open calendar (don't close-reopen)
  const retOk = await clickDay(buildAria(retDate));
  if (!retOk) {
    logger.warn(`[FORM] Could not click flight return: ${buildAria(retDate)}`);
    await forceCloseCalendar();
    return false;
  }
  logger.info('[FORM] Flight return date clicked: ' + retDate.toDateString());

  // Step 5: Force-close the calendar
  await forceCloseCalendar();

  // Step 6: VERIFY the return date actually committed to the form. Witnessed
  // in search 14671 (DEL→IXL round-trip): clickDay succeeded on a date element,
  // but the Return field stayed "-" with red "Return date is required" text.
  // Etrav sometimes silently rejects range-picker clicks (e.g., when the click
  // lands during a re-render, or the date is the same-day as departure).
  // If the return wrapper still shows "-", retry the range selection once.
  const retVerify = await page.evaluate(() => {
    const wrappers = document.querySelectorAll('.react-datepicker-wrapper');
    if (wrappers.length < 2) return { retText: '', hasError: false };
    const retText = (wrappers[1].textContent || '').trim();
    const bodyText = document.body.innerText || '';
    const hasError = /return\s*date\s*is\s*required/i.test(bodyText);
    return { retText, hasError };
  }).catch(() => ({ retText: '', hasError: false }));
  // CRITICAL PARSE FIX (search 84426-8u4gefg LKO→DXB INTL round-trip): the old
  // check `retText === '-'` was WRONG. wrappers[1].textContent returns the FULL
  // text of the wrapper — the "Return?" label + "-" placeholder + red error
  // "Return date is required". Real value looked like:
  //   "Return?-Return date is required"
  // which is neither empty nor equal to '-'. Verification passed silently even
  // though Etrav had rejected our return click — no retry fired, form submitted
  // with empty return, got AUTOMATION_FIELD_INCOMPLETE.
  //
  // Fix: a COMMITTED date shows a pattern like "9 May'26" in the wrapper text.
  // Detect commit by the date pattern; detect failure by the error text.
  const DATE_PATTERN = /\d{1,2}\s+\w{3}\s*[''`]\s*\d{2}/;
  const committed = DATE_PATTERN.test(retVerify.retText) && !retVerify.hasError;
  if (!committed) {
    logger.warn('[FORM] Return date did NOT commit (wrapper text: "' + (retVerify.retText || '').slice(0, 80) + '"' + (retVerify.hasError ? ', error visible' : '') + ') — retrying range selection up to 3x');
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // FORCE-CLOSE any lingering half-open calendar from the previous
        // attempt so the wrapper click below actually re-opens it fresh.
        await forceCloseCalendar();
        await page.waitForTimeout(400);
        // CRITICAL: page.$ (plural) — the old code had page.$ (singular) which
        // returns a single ElementHandle, making wrappers2[0] always undefined.
        // That silent no-op caused all 3 retries to finish in <1 second without
        // doing anything (witnessed in search 10236-drvaydr).
        const wrappers2 = await page.$('.react-datepicker-wrapper');
        if (wrappers2[0]) {
          await wrappers2[0].click({ force: true });
          await page.waitForTimeout(1200 + attempt * 300);
          // Verify calendar actually opened before clicking day cells
          const cal = await page.$('.react-datepicker');
          if (!cal) {
            logger.warn('[FORM] Retry #' + attempt + ': calendar did not open after wrapper click');
            continue;
          }
          await clickDay(buildAria(depDate));
          await page.waitForTimeout(800 + attempt * 300);
          await clickDay(buildAria(retDate));
          await page.waitForTimeout(600 + attempt * 300);
          await forceCloseCalendar();
        }
      } catch (retryErr) {
        logger.warn('[FORM] Return date retry #' + attempt + ' threw: ' + retryErr.message);
      }
      const check = await page.evaluate(() => {
        const wrappers = document.querySelectorAll('.react-datepicker-wrapper');
        const txt = wrappers[1] ? (wrappers[1].textContent || '').trim() : '';
        const err = /return\s*date\s*is\s*required/i.test(document.body.innerText || '');
        return { txt, err };
      }).catch(() => ({ txt: '', err: true }));
      if (DATE_PATTERN.test(check.txt) && !check.err) {
        logger.info('[FORM] Return date committed on retry #' + attempt + ': ' + check.txt.slice(0, 60));
        return true;
      }
      logger.warn('[FORM] Return date retry #' + attempt + ' did not commit');
    }
    logger.warn('[FORM] Return date still not set after 3 retries — aborting range pick');
    return false;
  }

  return true;
}

/**
 * Pick hotel check-in AND check-out dates on Etrav's hotel page.
 * The hotel page uses a SINGLE range-mode react-datepicker opened by clicking
 * the "Check - In" label. First click sets check-in, second click sets check-out.
 */
async function pickHotelDateRange(page, checkinDate, checkoutDate) {
  const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  const daySuffix = (d) => {
    if (d >= 11 && d <= 13) return 'th';
    const last = d % 10;
    return last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th';
  };
  const buildAria = (date) =>
    `Choose ${weekdays[date.getDay()]}, ${months[date.getMonth()]} ${date.getDate()}${daySuffix(date.getDate())}, ${date.getFullYear()}`;

  // Helper: force-close any open calendar
  const forceCloseCalendar = async () => {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    if (await page.$('.react-datepicker')) {
      await page.mouse.click(640, 50);
      await page.waitForTimeout(300);
    }
    if (await page.$('.react-datepicker')) {
      await page.evaluate(() => {
        document.querySelectorAll('.react-datepicker__tab-loop, .react-datepicker-popper, .react-datepicker').forEach(el => {
          el.style.display = 'none';
        });
      }).catch(() => {});
      await page.waitForTimeout(200);
    }
  };

  // Helper: navigate months and click a target day in the open calendar
  // Does NOT close the calendar — caller decides when to close
  // Robust against re-render race conditions: waits for stable bounding box, multiple click strategies
  const clickDay = async (ariaLabel) => {
    for (let nav = 0; nav < 18; nav++) {
      // Find the day element
      const el = await page.$(`.react-datepicker__day[aria-label="${ariaLabel}"]:not(.react-datepicker__day--disabled)`);
      if (el) {
        // Wait for the element to have a stable, visible bounding box (handles re-render races)
        await page.waitForFunction((label) => {
          const day = document.querySelector(`.react-datepicker__day[aria-label="${label}"]:not(.react-datepicker__day--disabled)`);
          if (!day) return false;
          const rect = day.getBoundingClientRect();
          return rect.width > 5 && rect.height > 5 && rect.top >= 0 && rect.bottom <= window.innerHeight + 100;
        }, ariaLabel, { timeout: 5000 }).catch(() => {});

        // Re-find the element (the previous handle may be stale after re-render)
        const freshEl = await page.$(`.react-datepicker__day[aria-label="${ariaLabel}"]:not(.react-datepicker__day--disabled)`);
        const target = freshEl || el;

        // Try scrolling into view explicitly
        await target.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(300);

        // Try multiple click strategies until one succeeds
        let clicked = false;
        // Strategy 1: Playwright force click
        try {
          await target.click({ force: true, timeout: 5000 });
          clicked = true;
        } catch (e1) {
          logger.warn('[FORM] clickDay strategy 1 failed: ' + e1.message.substring(0, 60));
        }
        // Strategy 2: Bounding box mouse click
        if (!clicked) {
          try {
            const box = await target.boundingBox();
            if (box && box.width > 0) {
              await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
              clicked = true;
            }
          } catch (e2) {
            logger.warn('[FORM] clickDay strategy 2 failed: ' + e2.message.substring(0, 60));
          }
        }
        // Strategy 3: JavaScript native click (bypasses Playwright actionability)
        if (!clicked) {
          try {
            await target.evaluate(e => {
              e.scrollIntoView({ block: 'center', behavior: 'instant' });
              e.click();
            });
            clicked = true;
          } catch (e3) {
            logger.warn('[FORM] clickDay strategy 3 failed: ' + e3.message.substring(0, 60));
          }
        }

        if (clicked) {
          await page.waitForTimeout(500);
          return true;
        }
        // All 3 strategies failed — try next month nav as last resort
        logger.warn('[FORM] All click strategies failed for ' + ariaLabel);
        return false;
      }
      const next = await page.$('.react-datepicker__navigation--next');
      if (!next) return false;
      await next.click({ force: true });
      await page.waitForTimeout(300);
    }
    return false;
  };

  // Step 1: Click the Check-In label to open the range picker
  const checkInLabel = await page.evaluateHandle(() =>
    Array.from(document.querySelectorAll('label'))
      .find(l => /check\s*-\s*in/i.test(l.textContent || '')) || null
  );
  const labelEl = checkInLabel.asElement();
  if (!labelEl) {
    logger.warn('[FORM] Hotel Check-In label not found');
    return false;
  }
  await labelEl.click({ force: true });
  await page.waitForTimeout(1000);

  // Verify calendar opened
  if (!(await page.$('.react-datepicker'))) {
    logger.warn('[FORM] Hotel date picker did not open');
    return false;
  }

  // Step 2: Click check-in date
  const inOk = await clickDay(buildAria(checkinDate));
  if (!inOk) {
    logger.warn(`[FORM] Could not click hotel check-in: ${buildAria(checkinDate)}`);
    await forceCloseCalendar();
    return false;
  }
  logger.info('[FORM] Hotel check-in date clicked: ' + checkinDate.toDateString());

  // Step 3: The calendar stays open — now click checkout date in the same calendar
  // Short wait for React to process the check-in selection
  await page.waitForTimeout(500);

  // Step 4: Click checkout date in the same open calendar
  const outOk = await clickDay(buildAria(checkoutDate));
  if (!outOk) {
    logger.warn(`[FORM] Could not click hotel check-out: ${buildAria(checkoutDate)}`);
    await forceCloseCalendar();
    return false;
  }
  logger.info('[FORM] Hotel check-out date clicked: ' + checkoutDate.toDateString());

  // Step 5: Force-close the calendar
  await forceCloseCalendar();

  return true;
}

/**
 * Select trip type (One Way / Round Trip / Multi City) via the radio label.
 */
async function selectTripType(page, tripType) {
  const labelMap = {
    'one-way': 'One Way',
    'round-trip': 'Round Trip',
    'multi-city': 'Multi City',
  };
  const labelText = labelMap[tripType] || 'One Way';

  // Find label by text content
  const handle = await page.evaluateHandle((text) => {
    const labels = Array.from(document.querySelectorAll('label'));
    return labels.find(l => l.textContent?.trim() === text) || null;
  }, labelText);

  const el = handle.asElement();
  if (el) {
    await el.click({ force: true });
    await page.waitForTimeout(400);
    return true;
  }
  return false;
}

/**
 * Click the Search Flight button.
 */
/**
 * Multi-strategy click for Search Flight / Search Hotel buttons.
 * Tries 4 strategies in sequence; succeeds if any one works.
 *  1. Aggressive dismiss of any open overlays (calendar/dropdown can hide button)
 *  2. Scroll button into view
 *  3. Playwright force click
 *  4. Mouse click at button center via getBoundingClientRect
 *  5. JS-native HTMLElement.click() (bypasses Playwright actionability checks)
 */
async function clickSearchButton(page, textRegex, label) {
  // Step 1: Force-close any open overlays that might cover the button
  try {
    await page.evaluate(() => {
      ['.react-datepicker__tab-loop', '.react-datepicker-popper', '.react-datepicker',
       '[class*="dropdown"][class*="open"]', '[class*="popup"]'].forEach(sel => {
        document.querySelectorAll(sel).forEach(el => {
          if (el.id !== 'root' && el.id !== 'portal-root') el.style.display = 'none';
        });
      });
    }).catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(200);
  } catch {}

  // Step 2: Find the button and scroll it into view
  const sourceText = textRegex.source.replace(/\\/g, '');
  const btnHandle = await page.evaluateHandle((src) => {
    const re = new RegExp(src, 'i');
    const btns = Array.from(document.querySelectorAll('button'));
    const btn = btns.find(b => re.test(b.textContent || ''));
    if (btn) {
      btn.scrollIntoView({ behavior: 'instant', block: 'center' });
      return btn;
    }
    return null;
  }, sourceText);
  const el = btnHandle.asElement();
  if (!el) {
    logger.warn('[FORM] Search ' + label + ' button not found in DOM');
    return false;
  }
  await page.waitForTimeout(300);

  // Step 3: Playwright force click
  try {
    await el.click({ force: true, timeout: 5000 });
    return true;
  } catch (e1) {
    logger.warn('[FORM] Search ' + label + ' strategy 1 (force click) failed: ' + e1.message.substring(0, 80));
  }

  // Step 4: Mouse click at button bounding box center
  try {
    const box = await el.boundingBox();
    if (box && box.width > 0 && box.height > 0) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      return true;
    }
  } catch (e2) {
    logger.warn('[FORM] Search ' + label + ' strategy 2 (mouse click) failed: ' + e2.message.substring(0, 80));
  }

  // Step 5: JS native click — bypasses all Playwright actionability checks
  try {
    await el.evaluate(b => {
      b.scrollIntoView({ block: 'center' });
      b.click();
    });
    return true;
  } catch (e3) {
    logger.warn('[FORM] Search ' + label + ' strategy 3 (JS click) failed: ' + e3.message.substring(0, 80));
  }

  return false;
}

async function clickSearchFlight(page) {
  return clickSearchButton(page, /Search Flight/i, 'Flight');
}

/**
 * Click the Search Hotels button.
 */
async function clickSearchHotels(page) {
  return clickSearchButton(page, /Search Hotel/i, 'Hotel');
}

/**
 * Count visible flight results on the results page.
 * Etrav result cards: try a few common class patterns.
 */
// Etrav-specific result card selectors (discovered via DOM inspection):
// - One-way flights use .one_way_card
// - Round-trip flights use .round_trip_card or similar
// - All are wrapped in .accordion_container.one_way_container (or round_trip_container)
const FLIGHT_RESULT_SELECTOR =
  '.accordion_container.one_way_container, .accordion_container.round_trip_container, .one_way_card, .round_trip_card, .accordion_container';

async function countFlightResults(page) {
  try {
    // Count using multiple selectors — prefer accordion_container (Etrav's actual cards)
    return await page.evaluate(() => {
      // Primary: .accordion_container cards (actual Etrav flight result cards)
      const accordions = document.querySelectorAll('.accordion_container');
      if (accordions.length > 0) return accordions.length;
      // Fallback: older .one_way_card / .round_trip_card
      const legacy = document.querySelectorAll('.one_way_card, .round_trip_card');
      return legacy.length;
    });
  } catch { return 0; }
}

/**
 * Also try to read the "Showing (N) Flights" text on the results page
 * to get the total result count (more accurate than counting rendered cards).
 */
async function getFlightResultCountFromText(page) {
  try {
    return await page.evaluate(() => {
      const bodyText = document.body.innerText || '';
      // Try "Showing [N] Flights" / "Showing (N) Flights" / "Showing N Flights"
      // Etrav uses [N] (square brackets) in some places — handle both bracket types
      const m1 = bodyText.match(/Showing\s*[\(\[]?\s*(\d+)\s*[\)\]]?\s*Flights?/i);
      if (m1) return parseInt(m1[1], 10);
      const m2 = bodyText.match(/Showing\s*[\(\[](\d+)[\)\]]/i);
      if (m2) return parseInt(m2[1], 10);
      return null;
    });
  } catch { return null; }
}

async function countHotelResults(page) {
  try {
    return await page.evaluate(() => {
      // Try CSS selectors first (broadest possible for Etrav hotel cards)
      const selectors = [
        '[class*="hotel-card"]', '[class*="hotel_card"]',
        '[class*="property-card"]', '[class*="property_card"]',
        '[class*="hotel-item"]', '[class*="hotel_item"]',
        '[class*="HotelCard"]', '[class*="hotelCard"]',
        '[class*="hotel_search"]', '[class*="hotel-search"]',
        '[class*="hotel_result"]', '[class*="hotel-result"]',
        '[class*="property_list"]', '[class*="property-list"]',
      ];
      let max = 0;
      for (const sel of selectors) {
        max = Math.max(max, document.querySelectorAll(sel).length);
      }
      if (max > 0) return max;

      // Fallback: count elements that contain "Book Now" buttons — each hotel card has one
      const bookBtns = document.querySelectorAll('button, a');
      let bookNowCount = 0;
      bookBtns.forEach(btn => {
        if (/book\s*now/i.test(btn.textContent)) bookNowCount++;
      });
      if (bookNowCount > 0) return bookNowCount;

      // Fallback 2: count distinct price elements (₹ symbol inside result areas)
      const priceEls = document.querySelectorAll('[class*="price"], [class*="rate"], [class*="amount"]');
      if (priceEls.length > 0) return priceEls.length;

      return 0;
    });
  } catch { return 0; }
}

/**
 * Read the current count from a pax row (Adults/Child/Infants).
 * Returns the number displayed between the - and + SVG buttons.
 */
async function readPaxRowCount(page, rowLabel) {
  return page.evaluate((label) => {
    // Find the row that starts with this label text
    const divs = document.querySelectorAll('div');
    for (const d of divs) {
      const t = d.textContent.trim();
      if (t.startsWith(label) && t.length < 50) {
        // Go up to the row container (parent of parent)
        const row = d.parentElement?.parentElement;
        if (!row) continue;
        // Find the count div — a leaf div whose text is just a digit
        let count = -1;
        row.querySelectorAll('div').forEach(cd => {
          if (cd.children.length === 0 && /^\d+$/.test(cd.textContent.trim())) {
            count = parseInt(cd.textContent.trim(), 10);
          }
        });
        if (count >= 0) return count;
      }
    }
    return -1;
  }, rowLabel);
}

/**
 * Click the + or - SVG button for a specific pax row using Playwright's real click.
 * Etrav rows: each has 2 SVGs (first = minus, second = plus).
 * We use Playwright locators to find the SVG and click its bounding box center.
 *
 * @param {Page} page
 * @param {string} rowLabel - 'Adults', 'Child', or 'Infants'
 * @param {'plus'|'minus'} direction
 */
async function clickPaxButton(page, rowLabel, direction) {
  // Get the bounding box of the target SVG
  const box = await page.evaluate((args) => {
    const { label, dir } = args;
    const divs = document.querySelectorAll('div');
    for (const d of divs) {
      const t = d.textContent.trim();
      if (t.startsWith(label) && t.length < 50) {
        const row = d.parentElement?.parentElement;
        if (!row) continue;
        const svgs = row.querySelectorAll('svg');
        if (svgs.length < 2) continue;
        const svg = dir === 'plus' ? svgs[1] : svgs[0];
        const rect = svg.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        }
      }
    }
    return null;
  }, { label: rowLabel, dir: direction });

  if (!box) return false;
  await page.mouse.click(box.x, box.y);
  // 250ms wait (raised from 150ms) — gives React enough time to process the click
  // even when other searches are running in parallel and competing for CPU
  await page.waitForTimeout(250);
  return true;
}

/**
 * Open the flight traveller dropdown and set Adults, Children, Infants.
 * Uses Playwright mouse clicks on the SVG +/- buttons — one click at a time
 * with verification after each to ensure React state updates.
 *
 * Etrav constraints: total adults+children ≤ 9, infants ≤ adults (max 2).
 * Row order: Adults (default 1), Child (default 0), Infants (default 0).
 */
async function fillFlightPax(page, pax, cabinClass) {
  if (!pax) return false;
  try {
    const targetAdults = Math.min(pax.adults || 1, 9);
    const targetChildren = Math.min(pax.children || 0, 9 - targetAdults);
    const targetInfants = Math.min(pax.infants || 0, targetAdults, 2);

    // Open the traveller dropdown
    const travellerEl = await page.evaluateHandle(() => {
      const divs = document.querySelectorAll('div');
      for (const d of divs) {
        if (/^\d+ Traveller/.test(d.textContent.trim()) && d.children.length === 0) return d;
      }
      return null;
    });
    const el = travellerEl.asElement();
    if (!el) { logger.warn('[FORM] Could not find traveller label'); return false; }
    await el.click({ force: true });
    await page.waitForTimeout(800);

    // Verify dropdown opened — look for "Adults" label
    const dropdownOpen = await page.evaluate(() =>
      !!Array.from(document.querySelectorAll('div')).find(d => d.textContent.trim() === 'Adults')
    );
    if (!dropdownOpen) { logger.warn('[FORM] Traveller dropdown did not open'); return false; }

    // Adjust Adults (click + or - until we reach target)
    const curAdults = await readPaxRowCount(page, 'Adults');
    if (curAdults >= 0 && curAdults !== targetAdults) {
      const dir = targetAdults > curAdults ? 'plus' : 'minus';
      const clicks = Math.abs(targetAdults - curAdults);
      for (let i = 0; i < clicks; i++) {
        await clickPaxButton(page, 'Adults', dir);
      }
    }

    // Adjust Children
    const curChildren = await readPaxRowCount(page, 'Child');
    if (curChildren >= 0 && curChildren !== targetChildren) {
      const dir = targetChildren > curChildren ? 'plus' : 'minus';
      const clicks = Math.abs(targetChildren - curChildren);
      for (let i = 0; i < clicks; i++) {
        await clickPaxButton(page, 'Child', dir);
      }
    }

    // Adjust Infants
    const curInfants = await readPaxRowCount(page, 'Infants');
    if (curInfants >= 0 && curInfants !== targetInfants) {
      const dir = targetInfants > curInfants ? 'plus' : 'minus';
      const clicks = Math.abs(targetInfants - curInfants);
      for (let i = 0; i < clicks; i++) {
        await clickPaxButton(page, 'Infants', dir);
      }
    }

    await page.waitForTimeout(300);

    // Select cabin class inside the traveller dropdown (Class Type dropdown)
    // Etrav options: Economy, Premium Economy, Business Class, First Class
    if (cabinClass && cabinClass !== 'Economy') {
      try {
        const cabinMap = { 'Business': 'Business Class', 'Premium Economy': 'Premium Economy', 'First Class': 'First Class' };
        const etravCabinText = cabinMap[cabinClass] || cabinClass;
        // Click the current cabin value to open the class type dropdown
        const cabinTrigger = await page.evaluate(() => {
          // Find the dropdown trigger showing current cabin (e.g., "Economy")
          const triggers = document.querySelectorAll('div.vnzleD30BoBVHP3ewbhY');
          for (const d of triggers) {
            const t = d.textContent.trim();
            if (['Economy','Business Class','Premium Economy','First Class'].includes(t)) {
              const rect = d.getBoundingClientRect();
              if (rect.width > 0) return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
            }
          }
          return null;
        });
        if (cabinTrigger) {
          await page.mouse.click(cabinTrigger.x, cabinTrigger.y);
          await page.waitForTimeout(500);
          // Click the target cabin option from the opened list
          const optionBox = await page.evaluate((target) => {
            const options = document.querySelectorAll('div.wzqhuSjt4h91wbC1oho6');
            for (const opt of options) {
              if (opt.textContent.trim() === target) {
                const rect = opt.getBoundingClientRect();
                if (rect.width > 0) return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
              }
            }
            return null;
          }, etravCabinText);
          if (optionBox) {
            await page.mouse.click(optionBox.x, optionBox.y);
            await page.waitForTimeout(300);
            logger.info('[FORM] Cabin class set: ' + cabinClass);
          } else {
            logger.warn('[FORM] Cabin option not found: ' + etravCabinText);
          }
        }
      } catch (cabinErr) {
        logger.warn('[FORM] Cabin class selection failed: ' + cabinErr.message);
      }
    }

    // Verify final counts
    const finalA = await readPaxRowCount(page, 'Adults');
    const finalC = await readPaxRowCount(page, 'Child');
    const finalI = await readPaxRowCount(page, 'Infants');

    // Close the dropdown by clicking OUTSIDE it on the page
    // Etrav's React dropdown only closes on a real outside mouse click
    // Click on the "Where From ?" input label area — safely outside the pax dropdown
    const closeTarget = await page.evaluate(() => {
      const input = document.querySelector('input[placeholder="Where From ?"]');
      if (input) {
        const rect = input.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y - 10 };
      }
      return { x: 100, y: 50 };
    });
    await page.mouse.click(closeTarget.x, closeTarget.y);
    await page.waitForTimeout(500);

    logger.info(`[FORM] Flight pax set: target ${targetAdults}A ${targetChildren}C ${targetInfants}I → actual ${finalA}A ${finalC}C ${finalI}I`);
    return true;
  } catch (err) {
    logger.warn('[FORM] Flight pax fill failed: ' + err.message);
    await page.mouse.click(100, 50).catch(() => {});
    await page.waitForTimeout(300);
    return false;
  }
}

/**
 * Open the hotel rooms & guests dropdown and set room count + pax per room.
 * Uses Playwright mouse clicks on SVG +/- buttons (same approach as flights).
 *
 * Etrav hotel DOM: clicking "N Room / N Guests" opens a panel.
 * Each room section has Adults (default 2) and Children (default 0) rows.
 * "Add Room" button adds more room sections.
 */
async function fillHotelPax(page, rooms, roomPax) {
  if (!roomPax || roomPax.length === 0) return false;
  try {
    // Open the rooms & guests dropdown
    const openerHandle = await page.evaluateHandle(() => {
      const divs = document.querySelectorAll('div');
      for (const d of divs) {
        const t = d.textContent.trim();
        if (/^\d+ Room/.test(t) && t.includes('Guest') && d.children.length <= 2) return d;
      }
      // Fallback
      for (const d of divs) {
        if (d.textContent.trim() === 'Rooms & Guests') return d;
      }
      return null;
    });
    const openerEl = openerHandle.asElement();
    if (!openerEl) { logger.warn('[FORM] Could not find hotel rooms dropdown'); return false; }
    await openerEl.click({ force: true });
    await page.waitForTimeout(800);

    // Count current rooms visible
    const currentRooms = await page.evaluate(() => {
      let count = 0;
      document.querySelectorAll('h4').forEach(h => { if (/Room \d/.test(h.textContent)) count++; });
      return count || 1;
    });

    // Add rooms if needed
    for (let i = currentRooms; i < rooms; i++) {
      const addBtn = await page.evaluateHandle(() => {
        const all = document.querySelectorAll('button, div, span');
        for (const b of all) {
          const t = b.textContent.trim();
          if (t === 'Add Room' || t === '+ Add Room' || t === 'Add room') return b;
        }
        return null;
      });
      const addEl = addBtn.asElement();
      if (addEl) {
        await addEl.click({ force: true });
        await page.waitForTimeout(400);
      }
    }

    // For each room, adjust Adults and Children
    // The hotel pax rows are inside room sections labelled "Room 1", "Room 2", etc.
    // Each room has its own Adults and Child rows — we need to target by room index.
    for (let roomIdx = 0; roomIdx < roomPax.length; roomIdx++) {
      const rp = roomPax[roomIdx];
      const targetA = rp.adults || 2;
      const targetC = rp.children || 0;
      const roomNum = roomIdx + 1;

      // Read current values for this room
      // Strategy: find "Room N" header, then the next Adults/Child rows belong to that room
      const counts = await page.evaluate((rNum) => {
        const headers = document.querySelectorAll('h4');
        let roomHeader = null;
        headers.forEach(h => { if (h.textContent.trim() === 'Room ' + rNum) roomHeader = h; });
        if (!roomHeader) return null;

        // The room section is the parent container of the header
        const section = roomHeader.closest('div[class]')?.parentElement || roomHeader.parentElement?.parentElement;
        if (!section) return null;

        function readCount(label) {
          let count = -1;
          section.querySelectorAll('div').forEach(d => {
            if (d.textContent.trim().startsWith(label) && d.textContent.trim().length < 50) {
              const row = d.parentElement?.parentElement;
              if (row) {
                row.querySelectorAll('div').forEach(cd => {
                  if (cd.children.length === 0 && /^\d+$/.test(cd.textContent.trim())) {
                    count = parseInt(cd.textContent.trim(), 10);
                  }
                });
              }
            }
          });
          return count;
        }
        return { adults: readCount('Adults'), children: readCount('Child') };
      }, roomNum);

      if (!counts) continue;

      // Build room-specific label selectors by finding the SVGs inside this room's section
      // We need bounding boxes scoped to this room
      const adjustHotelRow = async (roomNum2, label, current, target) => {
        if (current < 0 || current === target) return;
        const dir = target > current ? 'plus' : 'minus';
        const clicks = Math.abs(target - current);
        for (let i = 0; i < clicks; i++) {
          const box = await page.evaluate((args) => {
            const { rn, lbl, d } = args;
            const headers = document.querySelectorAll('h4');
            let roomHeader = null;
            headers.forEach(h => { if (h.textContent.trim() === 'Room ' + rn) roomHeader = h; });
            if (!roomHeader) return null;
            const section = roomHeader.closest('div[class]')?.parentElement || roomHeader.parentElement?.parentElement;
            if (!section) return null;
            // Find the row for this label within the room section
            let targetRow = null;
            section.querySelectorAll('div').forEach(el => {
              if (el.textContent.trim().startsWith(lbl) && el.textContent.trim().length < 50) {
                targetRow = el.parentElement?.parentElement;
              }
            });
            if (!targetRow) return null;
            const svgs = targetRow.querySelectorAll('svg');
            if (svgs.length < 2) return null;
            const svg = d === 'plus' ? svgs[1] : svgs[0];
            const rect = svg.getBoundingClientRect();
            if (rect.width > 0) return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
            return null;
          }, { rn: roomNum2, lbl: label, d: dir });
          if (box) {
            await page.mouse.click(box.x, box.y);
            await page.waitForTimeout(150);
          }
        }
      };

      await adjustHotelRow(roomNum, 'Adults', counts.adults, targetA);
      await adjustHotelRow(roomNum, 'Child', counts.children, targetC);
    }

    await page.waitForTimeout(300);

    // Close dropdown by clicking outside it
    // Click on the hotel destination input area — safely outside the rooms dropdown
    const hotelClose = await page.evaluate(() => {
      const input = document.querySelector('input[placeholder="Hotel name or Destination"], input.react-autosuggest__input');
      if (input) {
        const rect = input.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y - 10 };
      }
      return { x: 100, y: 50 };
    });
    await page.mouse.click(hotelClose.x, hotelClose.y);
    await page.waitForTimeout(500);

    const paxSummary = roomPax.map((r, i) => `R${i + 1}:${r.adults}A${r.children > 0 ? ' ' + r.children + 'C' : ''}`).join(' ');
    logger.info(`[FORM] Hotel pax set: ${rooms} rooms — ${paxSummary}`);
    return true;
  } catch (err) {
    logger.warn('[FORM] Hotel pax fill failed: ' + err.message);
    await page.mouse.click(100, 50).catch(() => {});
    await page.waitForTimeout(300);
    return false;
  }
}


/**
 * Toggle the "RoundTrip Fare" ticker checkbox on Etrav's flight form.
 * This ticker is only visible when "Round Trip" trip type is selected.
 * Default state is checked (enabled). We alternate per round-trip search.
 *
 * @param {Page} page
 * @param {boolean} shouldBeChecked - target state
 * @returns {{ ok: boolean, wasChecked: boolean|null, actualAfter: boolean|null }}
 */
async function toggleRoundTripFare(page, shouldBeChecked) {
  try {
    const state = await page.evaluate(() => {
      // Find the RoundTrip Fare label, then its sibling/parent checkbox
      const labels = Array.from(document.querySelectorAll('label'));
      const label = labels.find(l => l.textContent.trim() === 'RoundTrip Fare');
      if (!label) return { found: false };
      // Checkbox is usually a previous sibling or parent-adjacent
      const container = label.parentElement;
      const checkbox = container ? container.querySelector('input[type="checkbox"]') : null;
      if (!checkbox) return { found: false };
      return {
        found: true,
        checked: checkbox.checked,
        labelX: label.getBoundingClientRect().x,
        labelY: label.getBoundingClientRect().y,
        labelW: label.getBoundingClientRect().width,
        labelH: label.getBoundingClientRect().height
      };
    });

    if (!state.found) {
      logger.info('[FORM] RoundTrip Fare ticker not found (non-round-trip search)');
      return { ok: false, wasChecked: null, actualAfter: null };
    }

    const wasChecked = state.checked;
    if (wasChecked === shouldBeChecked) {
      logger.info('[FORM] RoundTrip Fare already ' + (shouldBeChecked ? 'checked' : 'unchecked') + ' — no action needed');
      return { ok: true, wasChecked, actualAfter: wasChecked };
    }

    // Click the label (safer than the hidden input) to toggle
    const clickX = state.labelX + state.labelW / 2;
    const clickY = state.labelY + state.labelH / 2;
    await page.mouse.click(clickX, clickY);
    await page.waitForTimeout(400);

    // Verify new state
    const afterState = await page.evaluate(() => {
      const labels = Array.from(document.querySelectorAll('label'));
      const label = labels.find(l => l.textContent.trim() === 'RoundTrip Fare');
      const container = label ? label.parentElement : null;
      const checkbox = container ? container.querySelector('input[type="checkbox"]') : null;
      return checkbox ? checkbox.checked : null;
    });

    const success = afterState === shouldBeChecked;
    if (success) {
      logger.info('[FORM] RoundTrip Fare toggled: ' + wasChecked + ' → ' + afterState);
    } else {
      logger.warn('[FORM] RoundTrip Fare toggle may have failed: wanted ' + shouldBeChecked + ' got ' + afterState);
    }
    return { ok: success, wasChecked, actualAfter: afterState };
  } catch (err) {
    logger.warn('[FORM] RoundTrip Fare toggle error: ' + err.message);
    return { ok: false, wasChecked: null, actualAfter: null };
  }
}


module.exports = {
  dismissAllOverlays,
  fillAutosuggest,
  isFormCrashed,
  pickReactDate,
  pickFlightDateRange,
  pickHotelDateRange,
  selectTripType,
  clickSearchButton,
  clickSearchFlight,
  clickSearchHotels,
  countFlightResults,
  countHotelResults,
  getFlightResultCountFromText,
  fillFlightPax,
  toggleRoundTripFare,
  fillHotelPax,
  FLIGHT_RESULT_SELECTOR,
};
