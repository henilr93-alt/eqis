#!/usr/bin/env node
/**
 * ecdReconResults.js — Inspects the ECD results page so we can teach the
 * robot where to find hotel names and prices.
 *
 * What it does:
 *   1. Logs in to Etrav
 *   2. Clicks "ECD Hotels" → fills UAE/Dubai/dates → clicks Search
 *   3. Waits up to 90 seconds for hotels to appear ("Showing X Hotels from Y")
 *   4. Saves a copy of the page AND probes for likely hotel-card elements
 *   5. Saves everything in reports/ecd/recon/<timestamp>-results/
 *
 * Read-only. Does not touch engine state.
 */

const fs = require('fs');
const path = require('path');
const browserModule = require('../engine2-journey/browser');
const login = require('../engine2-journey/login');
const logger = require('../utils/logger');
const settings = require('../config/settings');
const {
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

(async () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(__dirname, '..', 'reports', 'ecd', 'recon', stamp + '-results');
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

    // Dates
    const checkin = new Date(); checkin.setDate(checkin.getDate() + 10);
    const checkout = new Date(checkin); checkout.setDate(checkout.getDate() + 3);
    await pickHotelDateRange(page, checkin, checkout);
    await page.waitForTimeout(500);

    // Submit
    logger.info('[RECON] Clicking Search Hotel');
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        /search\s*hotel/i.test(b.textContent || ''));
      if (btn) { btn.scrollIntoView({ block: 'center' }); btn.click(); }
    });

    // Wait for redirect to /hotels/search-results
    await page.waitForFunction(() => /\/hotels(\/search-results)?/.test(window.location.pathname)
      && !/\/echotel/.test(window.location.pathname), { timeout: 20000 }).catch(() => {});
    logger.info('[RECON] Landed at: ' + page.url());

    // Wait until we see "Showing X Hotels" or 90s elapsed
    const waitedFor = await page.waitForFunction(() => {
      const t = (document.body.innerText || '').toLowerCase();
      return /showing\s+\d+\s+hotels?/.test(t);
    }, { timeout: 90000 }).then(() => true).catch(() => false);

    logger.info('[RECON] "Showing X Hotels" seen: ' + waitedFor);
    await page.waitForTimeout(3000);  // let cards fully paint

    // Save the page HTML and a picture
    fs.writeFileSync(path.join(outDir, 'results-page.html'),
      await page.evaluate(() => document.documentElement.outerHTML));
    await page.screenshot({ path: path.join(outDir, 'results-page.png'), fullPage: true });
    logger.info('[RECON] Saved page HTML + screenshot');

    // Probe: look for repeating blocks that contain a hotel-name-like header AND a price-like text
    const probe = await page.evaluate(() => {
      const out = { url: window.location.href, showingHotelsText: null, candidates: [], priceTexts: [] };

      const bodyText = document.body.innerText || '';
      const showing = bodyText.match(/showing\s+(\d+)\s+hotels?\s+from\s+([\w\s]+)/i);
      out.showingHotelsText = showing ? showing[0] : null;

      // Find every leaf-ish element whose text contains a price marker
      const priceLeaves = Array.from(document.querySelectorAll('*')).filter((el) => {
        if (el.offsetParent === null) return false;
        if (el.children.length > 3) return false;
        const t = (el.textContent || '').trim();
        return /₹|\$/.test(t) && /\d{2,3}[,.]?\d{2,}/.test(t) && t.length < 80;
      });

      out.priceTexts = priceLeaves.slice(0, 15).map((el) => ({
        text: el.textContent.trim().slice(0, 80),
        tag: el.tagName,
        cls: (el.className || '').toString().slice(0, 120),
      }));

      // From each price-leaf, walk up to find a hotel-card container (with both name + price)
      const cardCandidates = new Map();
      for (const pe of priceLeaves) {
        let n = pe;
        for (let i = 0; i < 8 && n && n.parentElement; i++, n = n.parentElement) {
          const text = (n.textContent || '').trim();
          // A card should have at least 30 chars AND a hotel-ish name word
          if (text.length > 80 && text.length < 2000) {
            const cls = String(n.className || '');
            const key = n.tagName + '|' + cls.slice(0, 80);
            if (!cardCandidates.has(key)) {
              cardCandidates.set(key, {
                tag: n.tagName, cls: cls.slice(0, 200),
                sample: text.replace(/\s+/g, ' ').slice(0, 200),
                count: document.querySelectorAll(
                  `${n.tagName}${cls ? '.' + String(cls).split(/\s+/).filter(Boolean).map(c=>CSS.escape(c)).join('.') : ''}`
                ).length,
              });
              break;
            }
          }
        }
      }
      out.candidates = Array.from(cardCandidates.values()).slice(0, 10);

      return out;
    });

    fs.writeFileSync(path.join(outDir, 'probe.json'),
      JSON.stringify(probe, null, 2));
    logger.info('[RECON] Probe summary:');
    logger.info(JSON.stringify(probe, null, 2));

  } catch (err) {
    logger.error('[RECON] Failed: ' + err.message);
    try { await page.screenshot({ path: path.join(outDir, 'ERROR.png'), fullPage: true }); } catch { /* ignore */ }
  } finally {
    await browser.close().catch(() => {});
    logger.info('[RECON] Done. Outputs in: ' + outDir);
  }
})();
