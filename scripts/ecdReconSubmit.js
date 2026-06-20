#!/usr/bin/env node
/**
 * ecdReconSubmit.js — RECON-ONLY. Full ECD flow including submit + post-submit DOM dump.
 *
 * Goal: capture the page state AFTER clicking Search Hotel so we can lock the
 * result-card selectors that engine5-ecd needs.
 *
 * Output: reports/ecd/recon/<timestamp>/
 *   - 05-pre-submit.html
 *   - 05-pre-submit.png
 *   - 06-post-submit-2s.html / .png
 *   - 06-post-submit-10s.html / .png
 *   - 06-post-submit-30s.html / .png
 *   - card-probe.json   (analysis of likely result-card elements)
 *
 * Does NOT touch engine state. Pure read.
 */

const fs = require('fs');
const path = require('path');
const browserModule = require('../engine2-journey/browser');
const login = require('../engine2-journey/login');
const logger = require('../utils/logger');
const settings = require('../config/settings');
const {
  fillAutosuggest,  // not used, kept for reference
  pickHotelDateRange,
  dismissAllOverlays,
} = require('../utils/etravFormHelpers');

async function clickByText(page, text) {
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
  await page.evaluate((label) => {
    const all = Array.from(document.querySelectorAll('label, span, div'));
    const labelEl = all.find((el) => (el.textContent || '').trim().toLowerCase() === label.toLowerCase());
    if (!labelEl) return;
    let container = labelEl;
    for (let i = 0; i < 6 && container; i++, container = container.parentElement) {
      const trig = container.querySelector('input, [role="combobox"], [role="button"], select, .MuiSelect-select');
      if (trig) { trig.click(); return; }
    }
  }, labelText);
  await page.waitForTimeout(800);
}

async function pickOptionByText(page, text) {
  const handles = await page.$$('li, [role="option"], [class*="option"]');
  for (const h of handles) {
    try {
      const txt = await h.evaluate((el) => (el.textContent || '').trim());
      const visible = await h.evaluate((el) => el.offsetParent !== null);
      if (visible && txt.toLowerCase() === text.toLowerCase()) {
        await h.click({ force: true });
        return true;
      }
    } catch { /* ignore */ }
  }
  return false;
}

async function snapshot(page, outDir, stem) {
  fs.writeFileSync(path.join(outDir, stem + '.html'),
    await page.evaluate(() => document.documentElement.outerHTML));
  await page.screenshot({ path: path.join(outDir, stem + '.png'), fullPage: true });
  logger.info('[RECON] Snapshot saved: ' + stem);
}

(async () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(__dirname, '..', 'reports', 'ecd', 'recon', stamp + '-submit');
  fs.mkdirSync(outDir, { recursive: true });
  logger.info('[RECON] Output dir: ' + outDir);

  const { browser, page } = await browserModule.launch();
  try {
    await login.authenticate(page);

    await page.goto(settings.ETRAV_BASE_URL.replace(/\/$/, '') + '/hotels',
      { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await dismissAllOverlays(page).catch(() => {});

    await clickByText(page, 'ECD Hotels');
    await page.waitForTimeout(3000);
    await page.waitForLoadState('domcontentloaded').catch(() => {});

    // Fill form
    await openDropdownByLabel(page, 'Select Destination');
    await page.waitForTimeout(600);
    await pickOptionByText(page, 'United Arab Emirates');
    await page.waitForTimeout(700);

    await openDropdownByLabel(page, 'Select City');
    await page.waitForTimeout(600);
    await pickOptionByText(page, 'Dubai');
    await page.waitForTimeout(700);

    // Dates — reuse existing helper (we know it works now)
    const checkin = new Date(); checkin.setDate(checkin.getDate() + 10);
    const checkout = new Date(checkin); checkout.setDate(checkout.getDate() + 3);
    await pickHotelDateRange(page, checkin, checkout);
    await page.waitForTimeout(500);

    // Snapshot pre-submit
    await snapshot(page, outDir, '05-pre-submit');

    // Submit
    logger.info('[RECON] Clicking Search Hotel');
    const clicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        /search\s*hotel/i.test(b.textContent || ''));
      if (btn) { btn.scrollIntoView({ block: 'center' }); btn.click(); return true; }
      return false;
    });
    logger.info('[RECON] Submit clicked: ' + clicked);

    // Capture page state at 2s, 10s, 30s intervals
    for (const waitSec of [2, 10, 30]) {
      await page.waitForTimeout((waitSec - (waitSec === 2 ? 0 : (waitSec === 10 ? 2 : 10))) * 1000);
      await snapshot(page, outDir, `06-post-submit-${waitSec}s`);
      const url = page.url();
      logger.info('[RECON] After ' + waitSec + 's URL: ' + url);
    }

    // Probe for any card-like result elements
    const probe = await page.evaluate(() => {
      const out = { url: window.location.href, signals: [], cardCandidates: [], priceTexts: [] };

      const probeSelectors = [
        '[class*="hotel"][class*="card"]',
        '[class*="HotelCard"]',
        '[class*="result"]',
        '[class*="Result"]',
        '[class*="listing"]',
        '[class*="Listing"]',
        '[data-testid*="hotel"]',
        '[data-testid*="card"]',
        '.hotel-card',
        '.hotel_card',
        '.search-result',
      ];

      for (const sel of probeSelectors) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) {
          out.signals.push({
            selector: sel,
            count: els.length,
            firstClass: els[0].className,
            firstTag: els[0].tagName,
            firstInnerLen: (els[0].innerHTML || '').length,
          });
        }
      }

      // Look for elements containing rupee/currency symbols (likely price displays)
      const priceCandidates = Array.from(document.querySelectorAll('*')).filter((el) => {
        if (el.children.length > 0) return false; // leaf only
        if (el.offsetParent === null) return false;
        const t = (el.textContent || '').trim();
        return /₹|\$|INR|USD|AED/i.test(t) && /\d{3,}/.test(t);
      });
      out.priceTexts = priceCandidates.slice(0, 10).map((el) => ({
        text: el.textContent.trim().slice(0, 60),
        tag: el.tagName,
        cls: el.className,
        path: (() => {
          // Build path from root
          let p = [];
          let cur = el;
          for (let i = 0; i < 6 && cur && cur.parentElement; i++) {
            p.unshift(cur.tagName + (cur.className ? '.' + String(cur.className).split(' ')[0] : ''));
            cur = cur.parentElement;
          }
          return p.join(' > ');
        })(),
      }));

      return out;
    });

    fs.writeFileSync(path.join(outDir, 'card-probe.json'),
      JSON.stringify(probe, null, 2));
    logger.info('[RECON] Card probe written. Signals: ' + probe.signals.length +
      ', Price texts: ' + probe.priceTexts.length);
    logger.info(JSON.stringify(probe, null, 2).slice(0, 2000));

  } catch (err) {
    logger.error('[RECON] Failed: ' + err.message);
    try { await page.screenshot({ path: path.join(outDir, 'ERROR.png'), fullPage: true }); } catch { /* ignore */ }
  } finally {
    await browser.close().catch(() => {});
    logger.info('[RECON] Done. Outputs in: ' + outDir);
  }
})();
