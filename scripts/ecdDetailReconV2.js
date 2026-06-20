#!/usr/bin/env node
// V2 — click "Book Now" instead of the hotel name to open the hotel detail page.

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

// Find the target hotel card, then click its "Book Now" button.
// Track URL change to detect navigation success.
async function clickBookNowForHotel(page, targetName) {
  const beforeUrl = page.url();
  const result = await page.evaluate((tn) => {
    const cards = Array.from(document.querySelectorAll('.listingCard'));
    const tokens = tn.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    let bestI = -1, bestScore = 0;
    cards.forEach((c, i) => {
      const ntext = (c.textContent || '').toLowerCase();
      let s = 0;
      for (const t of tokens) if (ntext.includes(t)) s++;
      if (s > bestScore) { bestScore = s; bestI = i; }
    });
    if (bestI < 0) return { found: false };

    const card = cards[bestI];
    card.scrollIntoView({ block: 'center', behavior: 'instant' });
    // Look for a Book Now button inside the card
    const buttons = Array.from(card.querySelectorAll('button, a, [role="button"]'));
    const bookBtn = buttons.find((b) => /book\s*now/i.test((b.textContent || '').trim()) && b.offsetParent !== null);
    if (bookBtn) {
      bookBtn.click();
      return { found: true, clicked: 'book-now', cardIdx: bestI };
    }
    // Fallback: click the whole card
    card.click();
    return { found: true, clicked: 'card', cardIdx: bestI };
  }, targetName);

  await page.waitForTimeout(8000);
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(4000);
  const afterUrl = page.url();
  return { ...result, beforeUrl, afterUrl, urlChanged: beforeUrl !== afterUrl };
}

async function probeDetailPage(page) {
  return page.evaluate(() => {
    const out = { url: window.location.href, signals: [], roomTables: [], priceTexts: [], roomNames: [] };

    // Look for tables / lists of rooms with prices
    const tableLike = ['table', 'tbody', 'ul', '[role="table"]', '[class*="room" i] tbody', '[class*="rate" i]'];
    for (const sel of tableLike) {
      const els = document.querySelectorAll(sel);
      if (els.length > 0) {
        for (let i = 0; i < Math.min(3, els.length); i++) {
          const txt = (els[i].textContent || '').trim();
          if (txt.length > 50 && /₹|\d{3,}/.test(txt)) {
            out.roomTables.push({
              selector: sel, idx: i, cls: (els[i].className || '').toString().slice(0, 80),
              sample: txt.replace(/\s+/g, ' ').slice(0, 240),
            });
          }
        }
      }
    }

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

    // Room name candidates: short labels containing room-type keywords
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
        /(\bbreakfast\b|\bbreakfast included\b|\bbb\b|\bcp\b|\bmap\b|\bhalf\s*board\b|\ball\s*inclusive\b|\bao\b|room only|with\s*breakfast)/i.test(t);
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
  const outDir = path.join(__dirname, '..', 'reports', 'ecd', 'recon', stamp + '-detail-v2');
  fs.mkdirSync(outDir, { recursive: true });
  logger.info('[RECON] Output dir: ' + outDir);

  const { browser, page } = await browserModule.launch();
  try {
    await login.authenticate(page);

    // ---- ECD ----
    logger.info('[RECON V2] ECD side — navigating to /echotel');
    await page.goto(settings.ETRAV_BASE_URL.replace(/\/$/, '') + '/hotels', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await dismissAllOverlays(page).catch(() => {});

    await clickByText(page, 'ECD Hotels');
    await page.waitForTimeout(3000);
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

    await waitForListingCards(page);
    await snapshot(page, outDir, '01-ecd-listing');

    const ecdClick = await clickBookNowForHotel(page, TARGET_HOTEL);
    logger.info('[RECON V2] ECD Book Now click: ' + JSON.stringify(ecdClick));

    await snapshot(page, outDir, '02-ecd-detail');
    const ecdProbe = await probeDetailPage(page);
    fs.writeFileSync(path.join(outDir, '02-ecd-detail-probe.json'), JSON.stringify(ecdProbe, null, 2));
    logger.info('[RECON V2] ECD detail probe written. URL: ' + ecdProbe.url);

    // ---- BEDBANK ----
    logger.info('[RECON V2] Bedbank side — fresh /hotels search');
    await page.goto(settings.ETRAV_BASE_URL.replace(/\/$/, '') + '/hotels', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await dismissAllOverlays(page).catch(() => {});

    await fillAutosuggest(page, 'Hotel name or Destination', TARGET_CITY);
    await pickHotelDateRange(page, checkin, checkout);
    await page.waitForTimeout(500);
    await clickSearchHotel(page);
    await page.waitForFunction(() => /\/hotels\/search-results/.test(window.location.pathname),
      { timeout: 20000 }).catch(() => {});

    await waitForListingCards(page);
    await snapshot(page, outDir, '03-bedbank-listing');

    const bbClick = await clickBookNowForHotel(page, TARGET_HOTEL);
    logger.info('[RECON V2] Bedbank Book Now click: ' + JSON.stringify(bbClick));

    await snapshot(page, outDir, '04-bedbank-detail');
    const bbProbe = await probeDetailPage(page);
    fs.writeFileSync(path.join(outDir, '04-bedbank-detail-probe.json'), JSON.stringify(bbProbe, null, 2));
    logger.info('[RECON V2] Bedbank detail probe written. URL: ' + bbProbe.url);

  } catch (err) {
    logger.error('[RECON V2] Failed: ' + err.message);
    try { await page.screenshot({ path: path.join(outDir, 'ERROR.png'), fullPage: true }); } catch {}
  } finally {
    await browser.close().catch(() => {});
    logger.info('[RECON V2] Done. Outputs in: ' + outDir);
  }
})();
