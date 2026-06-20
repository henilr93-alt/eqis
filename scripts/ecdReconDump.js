#!/usr/bin/env node
/**
 * ecdReconDump.js — RECON-ONLY. Does NOT modify any engine state.
 *
 * Purpose: Capture the ECD form's DOM structure so we can write correct
 * date-picker and result-card selectors for engine5-ecd.
 *
 * What it does:
 *   1. Launch Playwright (headless)
 *   2. Login to Etrav
 *   3. Click "ECD Hotels" nav link → land on /echotel
 *   4. Open "Select Destination" dropdown → pick "United Arab Emirates"
 *   5. Open "Select City" dropdown → pick "Dubai"
 *   6. Click on the Check-In field to open the calendar
 *   7. Dump:
 *      - Full <body> HTML at this state
 *      - Just the calendar/datepicker subtree (whatever popup appeared)
 *      - All "button-like" candidates with their text + class + tag
 *      - Screenshot of the page with calendar open
 *   8. Save everything to reports/ecd/recon/<timestamp>/
 *   9. Close browser. NO date click, NO search submit, NO mirror engine.
 *
 * Run: node scripts/ecdReconDump.js
 */

const fs = require('fs');
const path = require('path');
const browserModule = require('../engine2-journey/browser');
const login = require('../engine2-journey/login');
const logger = require('../utils/logger');
const settings = require('../config/settings');
const { dismissAllOverlays } = require('../utils/etravFormHelpers');

async function clickElByText(page, text) {
  const handle = await page.evaluateHandle((t) => {
    const all = Array.from(document.querySelectorAll('a, button, [role="button"], span, div, li, label'));
    const el = all.find((e) => (e.textContent || '').trim().toLowerCase() === t.toLowerCase() && e.offsetParent !== null);
    if (el) el.scrollIntoView({ block: 'center' });
    return el || null;
  }, text);
  const el = handle.asElement();
  if (!el) return false;
  await el.click({ force: true });
  return true;
}

async function openDropdownByLabel(page, labelText) {
  // Click a label-associated control to open the dropdown
  const ok = await page.evaluate((label) => {
    const all = Array.from(document.querySelectorAll('label, span, div'));
    const labelEl = all.find((el) => (el.textContent || '').trim().toLowerCase() === label.toLowerCase());
    if (!labelEl) return false;
    let container = labelEl;
    for (let i = 0; i < 6 && container; i++, container = container.parentElement) {
      const trig = container.querySelector('input, [role="combobox"], [role="button"], select, .MuiSelect-select');
      if (trig) { trig.click(); return true; }
    }
    return false;
  }, labelText);
  await page.waitForTimeout(800);
  return ok;
}

async function pickOptionByText(page, text) {
  const handles = await page.$$('li, [role="option"], [class*="option"]');
  for (const h of handles) {
    try {
      const txt = await h.evaluate((el) => (el.textContent || '').trim());
      if (txt.toLowerCase() === text.toLowerCase()) {
        const visible = await h.evaluate((el) => el.offsetParent !== null);
        if (visible) {
          await h.click({ force: true });
          return true;
        }
      }
    } catch { /* ignore */ }
  }
  return false;
}

(async () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(__dirname, '..', 'reports', 'ecd', 'recon', stamp);
  fs.mkdirSync(outDir, { recursive: true });
  logger.info('[RECON] Output dir: ' + outDir);

  const { browser, page } = await browserModule.launch();
  try {
    await login.authenticate(page);

    // Navigate to /hotels first (where the ECD Hotels nav link is reliably visible)
    await page.goto(settings.ETRAV_BASE_URL.replace(/\/$/, '') + '/hotels', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await dismissAllOverlays(page).catch(() => {});

    // Click "ECD Hotels" in top nav
    logger.info('[RECON] Clicking ECD Hotels nav link');
    const navClicked = await clickElByText(page, 'ECD Hotels');
    if (!navClicked) throw new Error('Could not find ECD Hotels link');
    await page.waitForTimeout(3000);
    await page.waitForLoadState('domcontentloaded').catch(() => {});

    // Snapshot 1: bare ECD form
    fs.writeFileSync(path.join(outDir, '01-form-bare.html'),
      await page.evaluate(() => document.documentElement.outerHTML));
    await page.screenshot({ path: path.join(outDir, '01-form-bare.png'), fullPage: true });
    logger.info('[RECON] Snapshot 01 — bare ECD form saved');

    // Open Select Destination
    logger.info('[RECON] Opening Select Destination');
    await openDropdownByLabel(page, 'Select Destination');
    await page.waitForTimeout(700);
    fs.writeFileSync(path.join(outDir, '02-destination-dropdown.html'),
      await page.evaluate(() => document.documentElement.outerHTML));
    await page.screenshot({ path: path.join(outDir, '02-destination-dropdown.png'), fullPage: true });

    // Pick UAE
    await pickOptionByText(page, 'United Arab Emirates');
    await page.waitForTimeout(800);

    // Open Select City
    logger.info('[RECON] Opening Select City');
    await openDropdownByLabel(page, 'Select City');
    await page.waitForTimeout(700);
    fs.writeFileSync(path.join(outDir, '03-city-dropdown.html'),
      await page.evaluate(() => document.documentElement.outerHTML));

    // Pick Dubai (the only city)
    await pickOptionByText(page, 'Dubai');
    await page.waitForTimeout(800);

    // ─── THE CRITICAL CAPTURE: open the Check-In date picker ───
    logger.info('[RECON] Opening Check-In date picker');
    // Click on the Check-In label/field area
    await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('label, span, div'));
      const labelEl = all.find((el) => /check\s*-?\s*in/i.test((el.textContent || '').trim()));
      if (labelEl) {
        let container = labelEl;
        for (let i = 0; i < 6 && container; i++, container = container.parentElement) {
          const trig = container.querySelector('input, [role="button"], .MuiInputBase-root, [class*="datepicker"]');
          if (trig) { trig.click(); return; }
        }
        labelEl.click();
      }
    });
    await page.waitForTimeout(1500);

    // Snapshot the calendar-open state
    fs.writeFileSync(path.join(outDir, '04-calendar-open.html'),
      await page.evaluate(() => document.documentElement.outerHTML));
    await page.screenshot({ path: path.join(outDir, '04-calendar-open.png'), fullPage: true });
    logger.info('[RECON] Snapshot 04 — calendar open saved');

    // Bonus: probe the page for calendar-like structures and write a summary
    const calendarProbe = await page.evaluate(() => {
      const out = { signals: [] };

      // Common datepicker libraries
      const libSelectors = [
        '.react-datepicker',
        '.react-datepicker__month-container',
        '.MuiCalendarPicker-root',
        '.MuiDateCalendar-root',
        '[class*="calendar"]',
        '[class*="datepicker"]',
        '[class*="DatePicker"]',
        '[role="dialog"]',
        '[role="grid"]',
      ];
      for (const sel of libSelectors) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) {
          out.signals.push({
            selector: sel,
            count: els.length,
            firstClass: els[0].className,
            firstTag: els[0].tagName,
            innerHTMLLength: (els[0].innerHTML || '').length,
          });
        }
      }

      // Find every "day" cell candidate
      const dayCandidates = Array.from(document.querySelectorAll(
        '[class*="day"], [role="gridcell"], td, button'
      )).filter((el) => {
        if (el.offsetParent === null) return false;
        const txt = (el.textContent || '').trim();
        return /^\d{1,2}$/.test(txt);  // text is a number like a day number
      });
      out.dayCandidateCount = dayCandidates.length;
      out.daySamples = dayCandidates.slice(0, 5).map((el) => ({
        text: el.textContent.trim(),
        tag: el.tagName,
        cls: el.className,
        ariaLabel: el.getAttribute('aria-label'),
        dataAttrs: Object.fromEntries(
          Array.from(el.attributes).filter(a => a.name.startsWith('data-')).map(a => [a.name, a.value])
        ),
      }));

      // Look for next/prev month buttons
      const navCandidates = Array.from(document.querySelectorAll('button, [role="button"]')).filter((el) => {
        if (el.offsetParent === null) return false;
        const a = (el.getAttribute('aria-label') || '').toLowerCase();
        return a.includes('next') || a.includes('prev') || a.includes('previous');
      });
      out.navSamples = navCandidates.slice(0, 4).map((el) => ({
        text: el.textContent.trim(),
        ariaLabel: el.getAttribute('aria-label'),
        cls: el.className,
      }));

      return out;
    });

    fs.writeFileSync(path.join(outDir, 'calendar-probe.json'),
      JSON.stringify(calendarProbe, null, 2));
    logger.info('[RECON] Calendar probe:');
    logger.info(JSON.stringify(calendarProbe, null, 2));

  } catch (err) {
    logger.error('[RECON] Failed: ' + err.message);
    try {
      await page.screenshot({ path: path.join(outDir, 'ERROR.png'), fullPage: true });
    } catch { /* ignore */ }
  } finally {
    await browser.close().catch(() => {});
    logger.info('[RECON] Done. Outputs in: ' + outDir);
  }
})();
