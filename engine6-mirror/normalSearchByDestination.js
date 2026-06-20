// normalSearchByDestination.js — Searches the regular /hotels page for a
// destination/city and returns ALL hotels rendered on the results page.
//
// Strategy:
//   1. Go to /hotels (NOT /echotel — this is the normal search, no ECD mode)
//   2. Type the destination text into the autosuggest
//   3. Pick the suggestion
//   4. Fill dates
//   5. Click Search Hotel
//   6. Wait for /hotels/search-results to load (without isExtranet=true)
//   7. Scrape every .listingCard on the page
//
// The output is the same shape as ecdListExtractor produces, so the comparator
// can pair ECD prices against these by hotel name.
//
// ZERO IMPORTS FROM engine3-searchpulse.

const logger = require('../utils/logger');
const screenshotter = require('../utils/screenshotter');
const settings = require('../config/settings');
const {
  fillAutosuggest,
  pickHotelDateRange,
  dismissAllOverlays,
} = require('../utils/etravFormHelpers');

const RESULTS_READY_SELECTORS = [
  '.listingCard',
  '[class*="listingCard"]',
  '.listing-container',
];

function parsePrice(text) {
  if (!text) return null;
  const m = String(text).match(/₹\s*([\d,]+(?:\.\d+)?)/);
  if (m) {
    const n = parseFloat(m[1].replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  const cleaned = String(text).replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

async function clickSearchHotelNormal(page) {
  try { await page.keyboard.press('Escape').catch(() => {}); } catch {}
  await page.waitForTimeout(200);

  const clicked = await page.evaluate(() => {
    const re = /search\s*hotel/i;
    const buttons = Array.from(document.querySelectorAll('button'));
    const btn = buttons.find((b) => {
      if (b.offsetParent === null) return false;
      return re.test((b.textContent || '').trim()) && !b.disabled;
    });
    if (btn) {
      btn.scrollIntoView({ block: 'center', behavior: 'instant' });
      btn.click();
      return true;
    }
    return false;
  });

  return clicked;
}

async function waitForResults(page, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const realCards = await page.evaluate((sels) => {
      let count = 0;
      for (const s of sels) {
        const els = document.querySelectorAll(s);
        for (const el of els) {
          const txt = (el.textContent || '').trim();
          if (txt.length > 50) count++;
        }
      }
      return count;
    }, RESULTS_READY_SELECTORS);
    if (realCards > 0) {
      await page.waitForTimeout(3000);
      return true;
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function scrollAllResults(page) {
  // Many hotel listings use infinite scroll. Scroll down a few times to
  // load more cards before extracting.
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
    await page.waitForTimeout(1200);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
}

async function extractAllHotels(page) {
  return page.evaluate(() => {
    const out = [];
    const cards = Array.from(document.querySelectorAll('.listingCard'));
    for (const card of cards) {
      const nameEl =
        card.querySelector('h1, h2, h3, h4, h5, [class*="hotelName" i], [class*="hotel-name" i], [class*="title" i]') ||
        card.querySelector('strong, b');
      const name = nameEl ? (nameEl.textContent || '').trim() : '';
      const priceEl =
        card.querySelector('.currentPrice') ||
        card.querySelector('[class*="currentPrice" i]') ||
        card.querySelector('[class*="priceDetails" i]');
      const priceText = priceEl ? (priceEl.textContent || '').trim() : '';
      const addrEl = card.querySelector('[class*="address" i], [class*="location" i]');
      const address = addrEl ? (addrEl.textContent || '').trim() : '';
      out.push({ name, priceText, address });
    }
    return out;
  });
}

/**
 * Run one normal-search for a destination/city and return all hotels seen.
 *
 * @param {import('playwright').Page} page
 * @param {Object} opts
 * @param {string} opts.destinationText  what to type in the autosuggest (e.g. "Dubai", "Bangkok")
 * @param {string} opts.checkin
 * @param {string} opts.checkout
 * @param {string} opts.runId
 * @returns {Promise<{status, hotels, pageUrl, screenshotPath}>}
 */
async function searchNormalByDestination(page, opts) {
  const { destinationText, checkin, checkout, runId } = opts;
  const result = {
    destinationText,
    status: 'PENDING',
    hotels: [],
    pageUrl: null,
    screenshotPath: null,
    error: null,
  };

  const t0 = Date.now();
  try {
    const baseUrl = settings.ETRAV_BASE_URL.replace(/\/$/, '');
    await page.goto(baseUrl + '/hotels', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);
    await dismissAllOverlays(page).catch(() => {});

    // Fill destination via autosuggest
    const autosuggestOk = await fillAutosuggest(page, 'Hotel name or Destination', destinationText);
    if (!autosuggestOk) {
      result.status = 'AUTOSUGGEST_FAILED';
      result.error = 'Could not commit destination "' + destinationText + '" in autosuggest';
      return result;
    }

    // Dates
    const datesOk = await pickHotelDateRange(page, new Date(checkin), new Date(checkout));
    if (!datesOk) {
      result.status = 'DATE_PICKER_FAILED';
      result.error = 'Could not fill check-in / check-out dates on /hotels';
      return result;
    }

    // Submit
    const clicked = await clickSearchHotelNormal(page);
    if (!clicked) {
      result.status = 'SUBMIT_BUTTON_NOT_FOUND';
      result.error = 'Search Hotel button not found on /hotels';
      return result;
    }

    // Wait for redirect to /hotels/search-results
    await page.waitForFunction(() =>
      /\/hotels\/search-results/.test(window.location.pathname),
      { timeout: 20000 }
    ).catch(() => {});
    result.pageUrl = page.url();

    // Wait for hotel cards
    const ok = await waitForResults(page, 120000);
    if (!ok) {
      result.status = 'NO_RESULTS_RENDERED';
      result.error = 'Hotel cards did not render within timeout';
      return result;
    }

    // Scroll to load more cards (some lists use infinite scroll)
    await scrollAllResults(page);

    const hotels = await extractAllHotels(page);
    result.hotels = hotels
      .filter((h) => h.name)
      .map((h) => ({
        name: h.name,
        address: h.address,
        totalPrice: parsePrice(h.priceText),
        currency: 'INR',
        rawPriceText: h.priceText,
      }))
      .filter((h) => h.totalPrice !== null);
    result.status = result.hotels.length > 0 ? 'OK' : 'ZERO_RESULTS';
    logger.info('[NORMAL-SEARCH] Found ' + result.hotels.length + ' hotels for "' + destinationText + '"');
  } catch (err) {
    result.status = 'ERROR';
    result.error = err.message;
    logger.error('[NORMAL-SEARCH] Error for "' + destinationText + '": ' + err.message);
  } finally {
    result.loadTimeMs = Date.now() - t0;
    try {
      const shot = await screenshotter.takeStep(page, runId, 'mirror-dest-' + destinationText.replace(/\s+/g, '_'));
      if (shot) result.screenshotPath = shot;
    } catch { /* ignore */ }
  }

  return result;
}

module.exports = { searchNormalByDestination };
