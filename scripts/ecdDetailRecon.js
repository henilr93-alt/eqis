#!/usr/bin/env node
// ecdDetailRecon.js — Recon-only. Opens one ECD hotel's detail page AND the
// same hotel on the normal /hotels side, then saves both pages so we can find
// the room+meal+price labels.
//
// Target hotel: "Best Western Premier Sonasea Phu Quoc" (confirmed to exist in
// both inventories during the previous comparison run).

const fs = require('fs');
const path = require('path');
const browserModule = require('../engine2-journey/browser');
const login = require('../engine2-journey/login');
const logger = require('../utils/logger');
const settings = require('../config/settings');
const { fillAutosuggest, pickHotelDateRange, dismissAllOverlays } =
  require('../utils/etravFormHelpers');

const TARGET_HOTEL = 'Best Western Premier Sonasea Phu Quoc';
const TARGET_COUNTRY = 'Vietnam';
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
    } catch {}
  }
  return false;
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
  logger.info('[RECON] Snapshot saved: ' + stem);
}

async function clickHotelOnListing(page, targetName) {
  // Look through .listingCard boxes for the hotel whose name fuzzy-matches the target.
  const idx = await page.evaluate((tn) => {
    const cards = Array.from(document.querySelectorAll('.listingCard'));
    const tokens = tn.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    let bestI = -1, bestScore = 0;
    cards.forEach((c, i) => {
      const ntext = (c.textContent || '').toLowerCase();
      let s = 0;
      for (const t of tokens) if (ntext.includes(t)) s++;
      if (s > bestScore) { bestScore = s; bestI = i; }
    });
    return bestI;
  }, targetName);

  if (idx < 0) return null;

  // Try to click anywhere on the card that opens the detail page (often the name or Book Now)
  const handles = await page.$$('.listingCard');
  if (!handles[idx]) return null;

  // Try clicking the hotel name first
  const nameEl = await handles[idx].$('h1, h2, h3, h4, h5, [class*="hotelName" i], [class*="hotel-name" i]');
  if (nameEl) {
    await nameEl.scrollIntoViewIfNeeded().catch(() => {});
    await nameEl.click({ force: true }).catch(() => {});
  } else {
    await handles[idx].click({ force: true }).catch(() => {});
  }

  await page.waitForTimeout(3000);
  return idx;
}

(async () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(__dirname, '..', 'reports', 'ecd', 'recon', stamp + '-detail');
  fs.mkdirSync(outDir, { recursive: true });
  logger.info('[RECON] Output dir: ' + outDir);

  const { browser, page } = await browserModule.launch();
  try {
    await login.authenticate(page);

    // ──── ECD SIDE ────
    logger.info('[RECON] ECD side — navigating to /echotel');
    await page.goto(settings.ETRAV_BASE_URL.replace(/\/$/, '') + '/hotels',
      { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await dismissAllOverlays(page).catch(() => {});

    await clickByText(page, 'ECD Hotels');
    await page.waitForTimeout(3000);
    await page.waitForLoadState('domcontentloaded').catch(() => {});

    await openDropdownByLabel(page, 'Select Destination');
    await page.waitForTimeout(600);
    await pickOptionByText(page, TARGET_COUNTRY);
    await page.waitForTimeout(700);
    await openDropdownByLabel(page, 'Select City');
    await page.waitForTimeout(600);
    await pickOptionByText(page, TARGET_CITY);
    await page.waitForTimeout(700);

    const checkin = new Date(); checkin.setDate(checkin.getDate() + 10);
    const checkout = new Date(checkin); checkout.setDate(checkout.getDate() + 3);
    await pickHotelDateRange(page, checkin, checkout);
    await page.waitForTimeout(500);

    await clickSearchHotel(page);
    await page.waitForFunction(() => /\/hotels(\/search-results)?/.test(window.location.pathname)
      && !/\/echotel/.test(window.location.pathname), { timeout: 20000 }).catch(() => {});

    const cardsReady = await waitForListingCards(page);
    logger.info('[RECON] ECD cards loaded: ' + cardsReady);

    await snapshot(page, outDir, '01-ecd-listing');

    const idx = await clickHotelOnListing(page, TARGET_HOTEL);
    logger.info('[RECON] ECD clicked card index: ' + idx);

    // Detail page may open in same tab or new tab
    await page.waitForTimeout(5000);
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(4000);

    await snapshot(page, outDir, '02-ecd-detail');

    // Probe detail page for room+meal+price elements
    const ecdProbe = await page.evaluate(() => {
      const out = { url: window.location.href, signals: [], roomTexts: [], priceTexts: [], mealTexts: [] };
      const probeSelectors = [
        '[class*="room" i]', '[class*="Room" i]',
        '[class*="rate" i]',
        '[class*="meal" i]', '[class*="board" i]',
        'table tr', 'tbody tr',
      ];
      for (const sel of probeSelectors) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) out.signals.push({ selector: sel, count: els.length, firstCls: els[0].className });
      }
      // Price markers
      const pricers = Array.from(document.querySelectorAll('*')).filter((el) => {
        if (el.offsetParent === null) return false;
        if (el.children.length > 3) return false;
        const t = (el.textContent || '').trim();
        return /₹/.test(t) && /\d{3,}/.test(t) && t.length < 80;
      });
      out.priceTexts = pricers.slice(0, 12).map((el) => ({
        text: el.textContent.trim().slice(0, 80),
        tag: el.tagName,
        cls: (el.className || '').toString().slice(0, 100),
      }));
      // Room name candidates
      const roomers = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,[class*="room" i] strong, [class*="title" i]')).filter((el) => {
        if (el.offsetParent === null) return false;
        const t = (el.textContent || '').trim();
        return t.length > 4 && t.length < 100 && /room|suite|villa|deluxe|standard|superior|premium|king|queen|twin|double|single/i.test(t);
      });
      out.roomTexts = roomers.slice(0, 12).map((el) => ({
        text: el.textContent.trim().slice(0, 80),
        tag: el.tagName,
        cls: (el.className || '').toString().slice(0, 100),
      }));
      return out;
    });
    fs.writeFileSync(path.join(outDir, '02-ecd-detail-probe.json'), JSON.stringify(ecdProbe, null, 2));
    logger.info('[RECON] ECD detail probe written');

    // ──── BEDBANK SIDE ────
    logger.info('[RECON] Bedbank side — fresh search on /hotels');
    await page.goto(settings.ETRAV_BASE_URL.replace(/\/$/, '') + '/hotels',
      { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await dismissAllOverlays(page).catch(() => {});

    await fillAutosuggest(page, 'Hotel name or Destination', TARGET_CITY);
    await pickHotelDateRange(page, checkin, checkout);
    await page.waitForTimeout(500);
    await clickSearchHotel(page);
    await page.waitForFunction(() => /\/hotels\/search-results/.test(window.location.pathname),
      { timeout: 20000 }).catch(() => {});

    const bbCardsReady = await waitForListingCards(page);
    logger.info('[RECON] Bedbank cards loaded: ' + bbCardsReady);

    await snapshot(page, outDir, '03-bedbank-listing');

    const bbIdx = await clickHotelOnListing(page, TARGET_HOTEL);
    logger.info('[RECON] Bedbank clicked card index: ' + bbIdx);
    await page.waitForTimeout(5000);
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(4000);

    await snapshot(page, outDir, '04-bedbank-detail');

    const bbProbe = await page.evaluate(() => {
      const out = { url: window.location.href, signals: [], roomTexts: [], priceTexts: [], mealTexts: [] };
      const pricers = Array.from(document.querySelectorAll('*')).filter((el) => {
        if (el.offsetParent === null) return false;
        if (el.children.length > 3) return false;
        const t = (el.textContent || '').trim();
        return /₹/.test(t) && /\d{3,}/.test(t) && t.length < 80;
      });
      out.priceTexts = pricers.slice(0, 12).map((el) => ({
        text: el.textContent.trim().slice(0, 80),
        tag: el.tagName,
        cls: (el.className || '').toString().slice(0, 100),
      }));
      const roomers = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,[class*="room" i] strong, [class*="title" i]')).filter((el) => {
        if (el.offsetParent === null) return false;
        const t = (el.textContent || '').trim();
        return t.length > 4 && t.length < 100 && /room|suite|villa|deluxe|standard|superior|premium|king|queen|twin|double|single/i.test(t);
      });
      out.roomTexts = roomers.slice(0, 12).map((el) => ({
        text: el.textContent.trim().slice(0, 80),
        tag: el.tagName,
        cls: (el.className || '').toString().slice(0, 100),
      }));
      return out;
    });
    fs.writeFileSync(path.join(outDir, '04-bedbank-detail-probe.json'), JSON.stringify(bbProbe, null, 2));
    logger.info('[RECON] Bedbank detail probe written');

  } catch (err) {
    logger.error('[RECON] Failed: ' + err.message);
    try { await page.screenshot({ path: path.join(outDir, 'ERROR.png'), fullPage: true }); } catch {}
  } finally {
    await browser.close().catch(() => {});
    logger.info('[RECON] Done. Outputs in: ' + outDir);
  }
})();
