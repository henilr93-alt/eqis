#!/usr/bin/env node
// V4 — open room-details in new tab AND wait long enough for rooms to load.

const fs = require('fs');
const path = require('path');
const browserModule = require('../engine2-journey/browser');
const login = require('../engine2-journey/login');
const logger = require('../utils/logger');
const settings = require('../config/settings');
const { fillAutosuggest, pickHotelDateRange, dismissAllOverlays } =
  require('../utils/etravFormHelpers');

const TARGET_CITY = 'Phu Quoc Island';

async function clickSearchHotel(page) {
  return page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) =>
      b.offsetParent !== null && /search\s*hotel/i.test((b.textContent || '').trim()));
    if (btn) { btn.scrollIntoView({ block: 'center' }); btn.click(); return true; }
    return false;
  });
}

async function waitForListingCards(page, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const n = await page.evaluate(() => {
      let c = 0;
      for (const el of document.querySelectorAll('.listingCard')) {
        if ((el.textContent || '').trim().length > 50) c++;
      }
      return c;
    });
    if (n > 0) { await page.waitForTimeout(2000); return true; }
    await page.waitForTimeout(500);
  }
  return false;
}

// Wait for the room-details page to actually show rooms (the spinner goes away
// AND we see a ₹ price somewhere on the page).
async function waitForRoomsLoaded(page, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await page.evaluate(() => {
      // Check if there's a loading spinner still visible
      const spinners = Array.from(document.querySelectorAll('[class*="spinner" i], [class*="loading" i], [class*="loader" i], [class*="circular" i]'));
      const visibleSpinner = spinners.some(s => s.offsetParent !== null);
      // Check for price text
      const bodyText = (document.body.innerText || '');
      const hasPrice = /₹\s*[\d,]+/.test(bodyText);
      return !visibleSpinner && hasPrice;
    });
    if (ready) { await page.waitForTimeout(2500); return true; }
    await page.waitForTimeout(500);
  }
  return false;
}

async function snapshot(page, outDir, stem) {
  fs.writeFileSync(path.join(outDir, stem + '.html'),
    await page.evaluate(() => document.documentElement.outerHTML));
  await page.screenshot({ path: path.join(outDir, stem + '.png'), fullPage: true });
  logger.info('[V4] Snapshot saved: ' + stem);
}

async function openHotelDetailNewTab(context, page, targetName) {
  let newPage = null;
  const tabPromise = new Promise((resolve) => {
    const handler = (p) => { newPage = p; resolve(p); };
    context.once('page', handler);
    setTimeout(() => resolve(null), 15000);
  });

  await page.evaluate((tn) => {
    const cards = Array.from(document.querySelectorAll('.listingCard'));
    const tokens = (tn || '').toLowerCase().split(/\s+/).filter(w => w.length > 2);
    let bestI = 0, bestScore = -1;
    if (tokens.length > 0) {
      cards.forEach((c, i) => {
        const t = (c.textContent || '').toLowerCase();
        let s = 0;
        for (const tk of tokens) if (t.includes(tk)) s++;
        if (s > bestScore) { bestScore = s; bestI = i; }
      });
    }
    const card = cards[bestI];
    if (card) {
      card.scrollIntoView({ block: 'center' });
      const btn = card.querySelector('button.bookNow') ||
                  Array.from(card.querySelectorAll('button')).find(b => /book\s*now/i.test((b.textContent || '').trim()));
      if (btn) btn.click();
    }
  }, targetName);

  await Promise.race([tabPromise, page.waitForTimeout(10000)]);
  return newPage;
}

(async () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(__dirname, '..', 'reports', 'ecd', 'recon', stamp + '-detail-v4');
  fs.mkdirSync(outDir, { recursive: true });
  logger.info('[V4] Output dir: ' + outDir);

  const { browser, page } = await browserModule.launch();
  const context = page.context();
  try {
    await login.authenticate(page);

    logger.info('[V4] Bedbank /hotels search for Phu Quoc Island');
    await page.goto(settings.ETRAV_BASE_URL.replace(/\/$/, '') + '/hotels', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await dismissAllOverlays(page).catch(() => {});

    await fillAutosuggest(page, 'Hotel name or Destination', TARGET_CITY);
    const checkin = new Date(); checkin.setDate(checkin.getDate() + 10);
    const checkout = new Date(checkin); checkout.setDate(checkout.getDate() + 3);
    await pickHotelDateRange(page, checkin, checkout);
    await page.waitForTimeout(500);
    await clickSearchHotel(page);
    await page.waitForFunction(() => /\/hotels\/search-results/.test(window.location.pathname),
      { timeout: 20000 }).catch(() => {});
    await waitForListingCards(page);
    logger.info('[V4] Bedbank listing loaded — opening first hotel');

    const newPage = await openHotelDetailNewTab(context, page, null);
    if (!newPage) {
      logger.warn('[V4] No new tab opened');
      await snapshot(page, outDir, '02-bedbank-detail-no-tab');
      return;
    }

    logger.info('[V4] New tab URL: ' + newPage.url());
    await newPage.waitForLoadState('domcontentloaded').catch(() => {});

    const loaded = await waitForRoomsLoaded(newPage);
    logger.info('[V4] Rooms loaded: ' + loaded);

    await snapshot(newPage, outDir, '02-bedbank-detail');

  } catch (err) {
    logger.error('[V4] Failed: ' + err.message);
  } finally {
    await browser.close().catch(() => {});
    logger.info('[V4] Done. Outputs in: ' + outDir);
  }
})();
