#!/usr/bin/env node
// V3 — watch for a NEW tab opening when Book Now is clicked.

const fs = require('fs');
const path = require('path');
const browserModule = require('../engine2-journey/browser');
const login = require('../engine2-journey/login');
const logger = require('../utils/logger');
const settings = require('../config/settings');
const { fillAutosuggest, pickHotelDateRange, dismissAllOverlays } =
  require('../utils/etravFormHelpers');

const TARGET_CITY = 'Phu Quoc Island';

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
    const real = await page.evaluate(() => {
      let n = 0;
      for (const el of document.querySelectorAll('.listingCard')) {
        if ((el.textContent || '').trim().length > 50) n++;
      }
      return n;
    });
    if (real > 0) { await page.waitForTimeout(2500); return true; }
    await page.waitForTimeout(500);
  }
  return false;
}

async function snapshot(page, outDir, stem) {
  fs.writeFileSync(path.join(outDir, stem + '.html'),
    await page.evaluate(() => document.documentElement.outerHTML));
  await page.screenshot({ path: path.join(outDir, stem + '.png'), fullPage: true });
  logger.info('[RECON V3] Snapshot saved: ' + stem);
}

async function clickFirstBookNowAndWatchForTab(context, page) {
  const beforeUrl = page.url();
  let newPage = null;
  // Listen for any new tab opened by the click
  const tabPromise = new Promise((resolve) => {
    const handler = (p) => { newPage = p; resolve(p); };
    context.once('page', handler);
    setTimeout(() => resolve(null), 12000);
  });

  // Click the first listingCard's Book Now button via native JS
  const clicked = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.listingCard'));
    if (cards.length === 0) return false;
    const card = cards[0];
    card.scrollIntoView({ block: 'center' });
    const btn = card.querySelector('button.bookNow') ||
                Array.from(card.querySelectorAll('button')).find(b => /book\s*now/i.test((b.textContent || '').trim()));
    if (btn) { btn.click(); return true; }
    return false;
  });

  await Promise.race([tabPromise, page.waitForTimeout(8000)]);

  if (newPage) {
    await newPage.waitForLoadState('domcontentloaded').catch(() => {});
    await newPage.waitForTimeout(5000);
    return { clicked, newTab: true, newTabUrl: newPage.url(), newPage };
  }
  return { clicked, newTab: false, urlChanged: page.url() !== beforeUrl, currentUrl: page.url() };
}

async function probeDetailPage(page) {
  return page.evaluate(() => {
    const out = { url: window.location.href, roomNames: [], priceTexts: [], mealTexts: [], headings: [] };

    // All headings as a fingerprint
    out.headings = Array.from(document.querySelectorAll('h1,h2,h3,h4'))
      .map(el => ({ tag: el.tagName, cls: (el.className || '').toString().slice(0,80), text: (el.textContent||'').trim().slice(0,100) }))
      .filter(h => h.text.length > 0)
      .slice(0, 20);

    // Price markers
    const pricers = Array.from(document.querySelectorAll('*')).filter((el) => {
      if (el.offsetParent === null) return false;
      if (el.children.length > 3) return false;
      const t = (el.textContent || '').trim();
      return /₹/.test(t) && /\d{3,}/.test(t) && t.length < 100;
    });
    out.priceTexts = pricers.slice(0, 20).map((el) => ({
      text: el.textContent.trim().slice(0, 100),
      tag: el.tagName,
      cls: (el.className || '').toString().slice(0, 100),
    }));

    // Look for any element with text matching a room-type keyword
    const roomers = Array.from(document.querySelectorAll('*')).filter((el) => {
      if (el.offsetParent === null) return false;
      if (el.children.length > 2) return false;
      const t = (el.textContent || '').trim();
      return t.length > 4 && t.length < 100 &&
        /(deluxe|standard|superior|premium|suite|villa|cottage|club|executive|junior|king|queen|twin|double|single|family|garden|sea\s*view|ocean|pool)/i.test(t);
    });
    out.roomNames = roomers.slice(0, 20).map((el) => ({
      text: el.textContent.trim().slice(0, 100),
      tag: el.tagName,
      cls: (el.className || '').toString().slice(0, 100),
    }));

    // Meal plan markers
    const mealers = Array.from(document.querySelectorAll('*')).filter((el) => {
      if (el.offsetParent === null) return false;
      if (el.children.length > 2) return false;
      const t = (el.textContent || '').trim();
      return t.length > 2 && t.length < 60 &&
        /(\bbreakfast\b|\bbreakfast included\b|\bbb\b|\bcp\b|\bmap\b|\bhalf\s*board\b|\ball\s*inclusive\b|room only|with\s*breakfast)/i.test(t);
    });
    out.mealTexts = mealers.slice(0, 15).map((el) => ({
      text: el.textContent.trim().slice(0, 80),
      tag: el.tagName,
      cls: (el.className || '').toString().slice(0, 100),
    }));

    return out;
  });
}

(async () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(__dirname, '..', 'reports', 'ecd', 'recon', stamp + '-detail-v3');
  fs.mkdirSync(outDir, { recursive: true });
  logger.info('[RECON V3] Output dir: ' + outDir);

  const { browser, page } = await browserModule.launch();
  const context = page.context();
  try {
    await login.authenticate(page);

    // Skip ECD search to save time — go straight to bedbank
    logger.info('[RECON V3] Bedbank side — fresh /hotels search');
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
    await snapshot(page, outDir, '01-bedbank-listing');

    const result = await clickFirstBookNowAndWatchForTab(context, page);
    logger.info('[RECON V3] Result: ' + JSON.stringify({ ...result, newPage: undefined }));

    // Snapshot wherever we ended up
    const detailPage = result.newPage || page;
    await snapshot(detailPage, outDir, '02-bedbank-detail');
    const probe = await probeDetailPage(detailPage);
    fs.writeFileSync(path.join(outDir, '02-bedbank-detail-probe.json'), JSON.stringify(probe, null, 2));
    logger.info('[RECON V3] Probe written. URL: ' + probe.url);
  } catch (err) {
    logger.error('[RECON V3] Failed: ' + err.message);
    try { await page.screenshot({ path: path.join(outDir, 'ERROR.png'), fullPage: true }); } catch {}
  } finally {
    await browser.close().catch(() => {});
    logger.info('[RECON V3] Done. Outputs in: ' + outDir);
  }
})();
