#!/usr/bin/env node
// Test the detail scraper on one bedbank hotel AND one ECD hotel.

const browserModule = require('../engine2-journey/browser');
const login = require('../engine2-journey/login');
const logger = require('../utils/logger');
const settings = require('../config/settings');
const { fillAutosuggest, pickHotelDateRange, dismissAllOverlays } =
  require('../utils/etravFormHelpers');
const { openHotelDetailTab, extractRoomCombos } = require('../engine6-mirror/hotelDetailScraper');

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

(async () => {
  const { browser, page } = await browserModule.launch();
  const context = page.context();
  try {
    await login.authenticate(page);
    const checkin = new Date(); checkin.setDate(checkin.getDate() + 10);
    const checkout = new Date(checkin); checkout.setDate(checkout.getDate() + 3);

    // ──── BEDBANK ────
    console.log('\n========== BEDBANK SIDE ==========');
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

    const bbResult = await openHotelDetailTab(context, page, null);  // first card
    if (bbResult.newPage) {
      const combos = await extractRoomCombos(bbResult.newPage);
      console.log('Bedbank found ' + combos.length + ' rate options:');
      for (const c of combos.slice(0, 10)) {
        console.log('  ' + c.roomCategory + ' | ' + c.mealPlan + ' | ' + c.rawPriceText + (c.refundPolicy ? ' | ' + c.refundPolicy : ''));
      }
      await bbResult.newPage.close().catch(() => {});
    } else {
      console.log('Bedbank: no new tab (' + bbResult.error + ')');
    }

    // ──── ECD ────
    console.log('\n========== ECD SIDE ==========');
    await page.goto(settings.ETRAV_BASE_URL.replace(/\/$/, '') + '/hotels', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await dismissAllOverlays(page).catch(() => {});
    await clickByText(page, 'ECD Hotels');
    await page.waitForTimeout(3000);
    await openDropdownByLabel(page, 'Select Destination');
    await page.waitForTimeout(600);
    await pickOptionByText(page, 'Vietnam');
    await page.waitForTimeout(700);
    await openDropdownByLabel(page, 'Select City');
    await page.waitForTimeout(600);
    await pickOptionByText(page, 'Phu Quoc Island');
    await page.waitForTimeout(700);
    await pickHotelDateRange(page, checkin, checkout);
    await page.waitForTimeout(500);
    await clickSearchHotel(page);
    await page.waitForFunction(() => /\/hotels(\/search-results)?/.test(window.location.pathname)
      && !/\/echotel/.test(window.location.pathname), { timeout: 20000 }).catch(() => {});
    await waitForListingCards(page);

    const ecdResult = await openHotelDetailTab(context, page, null);  // first card
    if (ecdResult.newPage) {
      const combos = await extractRoomCombos(ecdResult.newPage);
      console.log('ECD found ' + combos.length + ' rate options:');
      for (const c of combos.slice(0, 10)) {
        console.log('  ' + c.roomCategory + ' | ' + c.mealPlan + ' | ' + c.rawPriceText + (c.refundPolicy ? ' | ' + c.refundPolicy : ''));
      }
      await ecdResult.newPage.close().catch(() => {});
    } else {
      console.log('ECD: no new tab (' + ecdResult.error + ')');
    }

  } catch (err) {
    console.error('FAILED:', err.message);
  } finally {
    await browser.close().catch(() => {});
  }
})();
