/**
 * CMT Trial Run — Discover the "Report a Technical Issue" form on Etrav.
 *
 * This script opens a HEADED browser, navigates to a real search results page,
 * clicks the camera icon, and discovers the CMT form fields (title, description, submit).
 *
 * Run: node eqis.js trial-cmt
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const browserModule = require('../engine2-journey/browser');
const login = require('../engine2-journey/login');

const METRICS_PATH = path.join(__dirname, '..', 'state', 'metricsHistory.json');

async function runCmtTrial() {
  logger.info('[CMT-TRIAL] Starting CMT escalation trial run (headed mode)...');

  // Find a real search results URL from recent metrics
  let searchUrl = null;
  try {
    const history = JSON.parse(fs.readFileSync(METRICS_PATH, 'utf-8'));
    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i];
      if (entry.engineType !== 'searchpulse') continue;
      for (const s of (entry.flightSearches || [])) {
        if (s.url && s.url.includes('/flights/oneway')) {
          searchUrl = s.url;
          logger.info('[CMT-TRIAL] Using search URL: ' + searchUrl.slice(0, 80) + '...');
          break;
        }
      }
      if (searchUrl) break;
    }
  } catch (e) {
    logger.warn('[CMT-TRIAL] Could not read metrics: ' + e.message);
  }

  if (!searchUrl) {
    searchUrl = 'https://new.etrav.in/flights';
    logger.warn('[CMT-TRIAL] No search URL found in metrics, using flights page');
  }

  let browser = null;
  try {
    // Launch in HEADED mode so camera icon works
    const result = await browserModule.launch({ headed: true });
    browser = result.browser;
    const page = result.page;

    // Login
    await login.authenticate(page);
    logger.info('[CMT-TRIAL] Logged in successfully');

    // Navigate to search results page
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(10000); // Wait for results to load
    logger.info('[CMT-TRIAL] On search results page: ' + page.url().slice(0, 80));

    // Step 1: Find and click the camera icon
    const iconSelector = '.screenshot-icon-wrapper';
    await page.waitForSelector(iconSelector, { timeout: 10000 });
    logger.info('[CMT-TRIAL] Camera icon found. Clicking...');

    await page.click(iconSelector);
    await page.waitForTimeout(5000); // Wait for screenshot capture + form

    // Step 2: Check if a modal/form appeared in #portal-root or anywhere
    const portalChildren = await page.evaluate(() => {
      const portal = document.getElementById('portal-root');
      return portal ? portal.children.length : -1;
    });
    logger.info('[CMT-TRIAL] #portal-root children after click: ' + portalChildren);

    // Step 3: Scan for ALL new visible elements (forms, modals, inputs, textareas)
    const formDiscovery = await page.evaluate(() => {
      const info = {};

      // Check all visible elements
      const allEls = Array.from(document.querySelectorAll('*'));
      const visibleEls = allEls.filter(el => el.offsetParent !== null || window.getComputedStyle(el).display !== 'none');

      // Find textareas
      info.textareas = visibleEls.filter(el => el.tagName === 'TEXTAREA').map(el => ({
        name: el.name, placeholder: el.placeholder, cls: el.className.toString().slice(0, 80),
        id: el.id, rows: el.rows,
      }));

      // Find text inputs (not the search form ones)
      info.textInputs = visibleEls.filter(el => el.tagName === 'INPUT' && el.type === 'text')
        .filter(el => el.placeholder !== 'Where From ?' && el.placeholder !== 'Where To ?')
        .map(el => ({
          name: el.name, placeholder: el.placeholder, cls: el.className.toString().slice(0, 80),
          id: el.id,
        }));

      // Find buttons with submit-like text
      info.submitButtons = visibleEls.filter(el => {
        const text = (el.textContent || '').toLowerCase().trim();
        return (el.tagName === 'BUTTON' || el.role === 'button') &&
          (text.includes('submit') || text.includes('send') || text.includes('report') || text.includes('save'));
      }).map(el => ({
        tag: el.tagName, text: (el.textContent || '').trim().slice(0, 40),
        cls: el.className.toString().slice(0, 80),
      }));

      // Find modal/dialog elements
      info.modals = visibleEls.filter(el => {
        const cls = (el.className?.toString?.() || '').toLowerCase();
        return cls.includes('modal') || cls.includes('dialog') || cls.includes('popup') ||
               cls.includes('overlay') || cls.includes('drawer');
      }).map(el => ({
        tag: el.tagName, cls: el.className.toString().slice(0, 80),
        text: (el.textContent || '').trim().slice(0, 200),
        childCount: el.children.length,
      }));

      // Find all screenshot-related elements
      info.screenshotEls = visibleEls.filter(el => {
        const cls = (el.className?.toString?.() || '').toLowerCase();
        return cls.includes('screenshot');
      }).map(el => ({
        tag: el.tagName, cls: el.className.toString().slice(0, 100),
        childCount: el.children.length,
        text: (el.textContent || '').trim().slice(0, 100),
      }));

      // Look at #portal-root content
      const portal = document.getElementById('portal-root');
      if (portal && portal.children.length > 0) {
        info.portalContent = portal.innerHTML.slice(0, 1000);
      }

      // Total visible element count
      info.totalVisible = visibleEls.length;

      return info;
    });

    logger.info('[CMT-TRIAL] === FORM DISCOVERY RESULTS ===');
    logger.info('[CMT-TRIAL] Text inputs found: ' + formDiscovery.textInputs.length);
    logger.info('[CMT-TRIAL] Textareas found: ' + formDiscovery.textareas.length);
    logger.info('[CMT-TRIAL] Submit buttons found: ' + formDiscovery.submitButtons.length);
    logger.info('[CMT-TRIAL] Modals found: ' + formDiscovery.modals.length);
    logger.info('[CMT-TRIAL] Screenshot elements: ' + formDiscovery.screenshotEls.length);
    logger.info('[CMT-TRIAL] Total visible elements: ' + formDiscovery.totalVisible);

    if (formDiscovery.textInputs.length > 0) {
      logger.info('[CMT-TRIAL] Text inputs: ' + JSON.stringify(formDiscovery.textInputs));
    }
    if (formDiscovery.textareas.length > 0) {
      logger.info('[CMT-TRIAL] Textareas: ' + JSON.stringify(formDiscovery.textareas));
    }
    if (formDiscovery.submitButtons.length > 0) {
      logger.info('[CMT-TRIAL] Submit buttons: ' + JSON.stringify(formDiscovery.submitButtons));
    }
    if (formDiscovery.modals.length > 0) {
      logger.info('[CMT-TRIAL] Modals: ' + JSON.stringify(formDiscovery.modals));
    }
    if (formDiscovery.portalContent) {
      logger.info('[CMT-TRIAL] Portal content: ' + formDiscovery.portalContent.slice(0, 300));
    }

    // Take screenshot of current state
    const ssPath = path.join(__dirname, '..', 'reports', 'cmt-trial-discovery.png');
    await page.screenshot({ path: ssPath, fullPage: false });
    logger.info('[CMT-TRIAL] Screenshot saved: ' + ssPath);

    // If form was found, try to fill it (but NOT submit)
    if (formDiscovery.textInputs.length > 0 || formDiscovery.textareas.length > 0) {
      logger.info('[CMT-TRIAL] Form fields detected! Attempting to fill...');

      // Fill title if found
      for (const inp of formDiscovery.textInputs) {
        const sel = inp.id ? '#' + inp.id : (inp.name ? `input[name="${inp.name}"]` : `input[placeholder="${inp.placeholder}"]`);
        try {
          await page.fill(sel, '[EQIS-TRIAL] Test Escalation — Please Ignore');
          logger.info('[CMT-TRIAL] Filled title: ' + sel);
          break;
        } catch { /* try next */ }
      }

      // Fill description if found
      for (const ta of formDiscovery.textareas) {
        const sel = ta.id ? '#' + ta.id : (ta.name ? `textarea[name="${ta.name}"]` : 'textarea');
        try {
          await page.fill(sel, 'Search ID: TRIAL-00001\nEngine: Flight Domestic\nSector: DEL→BOM\nRating: CRITICAL\nDuration: 45.2s\nResults: 0\n\nReported by: EQIS Automated QA System (Trial Run)');
          logger.info('[CMT-TRIAL] Filled description: ' + sel);
          break;
        } catch { /* try next */ }
      }

      // Take screenshot of filled form
      await page.waitForTimeout(1000);
      const filledPath = path.join(__dirname, '..', 'reports', 'cmt-trial-filled.png');
      await page.screenshot({ path: filledPath, fullPage: false });
      logger.info('[CMT-TRIAL] Filled form screenshot saved: ' + filledPath);

      logger.info('[CMT-TRIAL] === TRIAL COMPLETE (form found, filled, NOT submitted) ===');
    } else {
      logger.warn('[CMT-TRIAL] No form fields detected after clicking camera icon.');
      logger.warn('[CMT-TRIAL] The camera icon may need a different interaction or headed mode may need additional config.');

      // Log full page state for debugging
      const fullState = JSON.stringify(formDiscovery, null, 2);
      const debugPath = path.join(__dirname, '..', 'reports', 'cmt-trial-debug.json');
      fs.writeFileSync(debugPath, fullState);
      logger.info('[CMT-TRIAL] Debug info saved: ' + debugPath);
    }

    // Keep browser open for 10s so user can observe (headed mode)
    logger.info('[CMT-TRIAL] Keeping browser open for 10 seconds for observation...');
    await page.waitForTimeout(10000);

    await browser.close();
    logger.info('[CMT-TRIAL] Browser closed. Trial run complete.');
    return { success: true };
  } catch (err) {
    logger.error('[CMT-TRIAL] Trial failed: ' + err.message);
    if (browser) try { await browser.close(); } catch {}
    return { success: false, error: err.message };
  }
}

module.exports = { runCmtTrial };
