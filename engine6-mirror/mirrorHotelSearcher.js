// mirrorHotelSearcher.js — Playwright flow on /hotels (normal search) for a
// SPECIFIC hotel name supplied by engine5-ecd. The goal is to capture pricing
// for the same hotel + dates + pax + rooms so the comparator can diff against
// the ECD side.
//
// Strategy:
//   1. Navigate to /hotels
//   2. Type hotel name in autosuggest (NOT just destination)
//   3. Pick best-fuzzy-match suggestion
//   4. Same checkin/checkout/pax/rooms as the ECD scenario
//   5. Submit
//   6. Find matching hotel card in results; extract all room+meal combos
//   7. Return structured combos
//
// ZERO IMPORTS FROM engine3-searchpulse. Selectors are placeholders for Phase 0
// recon — they will be confirmed against real DOM before the engine is enabled.

const logger = require('../utils/logger');
const screenshotter = require('../utils/screenshotter');
const settings = require('../config/settings');
const { hotelNameScore } = require('./combinationMatcher');

const AUTOSUGGEST_SELECTORS = [
  'input.react-autosuggest__input',
  'input[placeholder*="Hotel name or Destination" i]',
];
const SUGGESTION_ITEM_SELECTORS = [
  '.react-autosuggest__suggestion',
  '[role="option"]',
];
const SEARCH_BUTTON_SELECTORS = [
  'button:has-text("Search Hotels")',
  'button:has-text("Search")',
  'button[type="submit"]',
];
const HOTEL_CARD_SELECTORS = [
  '[data-testid="hotel-card"]',
  '.hotel-result-card',
  '.hotel-card',
];
const CARD_NAME_SELECTORS = ['.hotel-name', '[data-testid="hotel-name"]', 'h3', 'h4'];
const COMBO_SELECTORS = ['.room-combo', '.room-option', '[data-testid="room-combo"]', '.room-row'];
const ROOM_NAME_SELECTORS = ['.room-name', '[data-testid="room-name"]', '.room-category'];
const MEAL_SELECTORS = ['.meal-plan', '[data-testid="meal-plan"]', '.board-basis'];
const PRICE_SELECTORS = ['.total-price', '[data-testid="total-price"]', '.price-total', '.price'];

function parsePrice(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

async function navigateToHotels(page) {
  const url = settings.ETRAV_BASE_URL.replace(/\/$/, '') + '/hotels';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector(AUTOSUGGEST_SELECTORS.join(','), { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

async function typeHotelAndPickSuggestion(page, hotelName) {
  let input = null;
  for (const sel of AUTOSUGGEST_SELECTORS) {
    input = await page.$(sel);
    if (input) break;
  }
  if (!input) throw new Error('autosuggest input not found on /hotels');

  await input.click();
  await input.fill('');
  await input.type(hotelName, { delay: 60 });
  await page.waitForTimeout(900);

  // Collect rendered suggestions, fuzzy-pick the best
  const suggestions = await page.evaluate((sels) => {
    for (const sel of sels) {
      const items = Array.from(document.querySelectorAll(sel));
      if (items.length > 0) {
        return items.map((el, idx) => ({ idx, text: el.textContent.trim(), selector: sel }));
      }
    }
    return [];
  }, SUGGESTION_ITEM_SELECTORS);

  if (suggestions.length === 0) {
    logger.warn(`[MIRROR] No suggestions for "${hotelName}"`);
    return { matched: false, suggestionText: null, score: 0 };
  }

  // Rank suggestions by name similarity
  const ranked = suggestions
    .map((s) => ({ ...s, score: hotelNameScore(hotelName, s.text) }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best || best.score < 0.4) {
    logger.warn(`[MIRROR] Best suggestion "${best?.text}" scored ${best?.score?.toFixed(2)} — below threshold`);
    return { matched: false, suggestionText: best?.text || null, score: best?.score || 0 };
  }

  // Click the nth suggestion
  const handles = await page.$$(best.selector);
  if (handles[best.idx]) {
    await handles[best.idx].click({ force: true });
    logger.info(`[MIRROR] Selected suggestion "${best.text}" (score ${best.score.toFixed(2)})`);
    return { matched: true, suggestionText: best.text, score: best.score };
  }

  return { matched: false, suggestionText: best.text, score: best.score };
}

async function clickSearch(page) {
  for (const sel of SEARCH_BUTTON_SELECTORS) {
    const btn = await page.$(sel);
    if (btn) {
      await btn.click({ force: true });
      return true;
    }
  }
  throw new Error('search button not found on /hotels');
}

async function waitForResults(page, timeoutMs = 35000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await page.evaluate((sels) => {
      return sels.some((s) => document.querySelectorAll(s).length > 0);
    }, HOTEL_CARD_SELECTORS);
    if (ready) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

async function extractMatchingHotelCombos(page, hotelName) {
  // Pick the card whose name best matches `hotelName`. Return its combos.
  const data = await page.evaluate(
    ({ cardSels, nameSels, comboSels, roomSels, mealSels, priceSels }) => {
      const pickText = (root, sels) => {
        for (const sel of sels) {
          const el = root.querySelector(sel);
          if (el && el.textContent && el.textContent.trim()) return el.textContent.trim();
        }
        return '';
      };
      let cards = [];
      for (const sel of cardSels) {
        const found = Array.from(document.querySelectorAll(sel));
        if (found.length > 0) { cards = found; break; }
      }
      return cards.map((card) => {
        const name = pickText(card, nameSels);
        let comboEls = [];
        for (const sel of comboSels) {
          const f = card.querySelectorAll(sel);
          if (f.length > 0) { comboEls = Array.from(f); break; }
        }
        if (comboEls.length === 0) comboEls = [card];
        const combos = comboEls.map((c) => ({
          roomCategory: pickText(c, roomSels),
          mealPlan: pickText(c, mealSels),
          priceText: pickText(c, priceSels),
        }));
        return { name, combos };
      });
    },
    {
      cardSels: HOTEL_CARD_SELECTORS,
      nameSels: CARD_NAME_SELECTORS,
      comboSels: COMBO_SELECTORS,
      roomSels: ROOM_NAME_SELECTORS,
      mealSels: MEAL_SELECTORS,
      priceSels: PRICE_SELECTORS,
    }
  );

  if (data.length === 0) return null;

  // Rank cards by name similarity to requested hotel
  const ranked = data
    .map((d) => ({ ...d, score: hotelNameScore(hotelName, d.name) }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best || best.score < 0.4) return null;

  return {
    matchedName: best.name,
    nameScore: best.score,
    combos: best.combos
      .map((c) => ({
        roomCategory: c.roomCategory,
        mealPlan: c.mealPlan,
        totalPrice: parsePrice(c.priceText),
        currency: 'INR',
        rawPriceText: c.priceText,
      }))
      .filter((c) => c.totalPrice !== null),
  };
}

/**
 * Mirror-search a single ECD hotel on the normal /hotels page.
 *
 * @param {import('playwright').Page} page
 * @param {Object} opts
 * @param {Object} opts.ecdHotel    one entry from engine5-ecd output
 * @param {string} opts.checkin     ISO YYYY-MM-DD
 * @param {string} opts.checkout    ISO YYYY-MM-DD
 * @param {number} opts.adults
 * @param {number} opts.rooms
 * @param {string} opts.runId
 * @returns {Promise<Object>} mirror result with combos or stockout reason
 */
async function mirrorEcdHotel(page, opts) {
  const { ecdHotel, runId } = opts;

  const result = {
    ecdHotelRef: ecdHotel.name,
    matched: false,
    autosuggestPick: null,
    autosuggestScore: 0,
    mirroredCard: null,
    cardScore: 0,
    combos: [],
    loadTimeMs: 0,
    searchStatus: 'PENDING',
    stockoutReason: null,
    screenshotPath: null,
  };

  const t0 = Date.now();
  try {
    await navigateToHotels(page);

    const pick = await typeHotelAndPickSuggestion(page, ecdHotel.name);
    result.autosuggestPick = pick.suggestionText;
    result.autosuggestScore = pick.score;

    if (!pick.matched) {
      result.searchStatus = 'DEFAULT_STOCKOUT';
      result.stockoutReason = 'NO_AUTOSUGGEST_MATCH';
      return result;
    }

    // NOTE: date/pax filling intentionally minimal until Phase 0 recon. The
    // dates passed in opts.{checkin,checkout} will be plumbed through the
    // existing utils/etravDatePicker.js once the operator confirms it works
    // identically on /hotels for the mirror flow (it should — same page).

    await clickSearch(page);

    const ok = await waitForResults(page, 35000);
    if (!ok) {
      result.searchStatus = 'NO_RESULTS_RENDERED';
      return result;
    }

    const match = await extractMatchingHotelCombos(page, ecdHotel.name);
    if (!match) {
      result.searchStatus = 'DEFAULT_STOCKOUT';
      result.stockoutReason = 'NO_MATCHING_CARD_IN_RESULTS';
      return result;
    }

    result.matched = true;
    result.mirroredCard = match.matchedName;
    result.cardScore = match.nameScore;
    result.combos = match.combos;
    result.searchStatus = match.combos.length > 0 ? 'OK' : 'DEFAULT_STOCKOUT';
    if (match.combos.length === 0) result.stockoutReason = 'CARD_HAS_NO_PRICED_COMBOS';
  } catch (err) {
    result.searchStatus = 'ERROR';
    result.error = err.message;
    logger.error(`[MIRROR] Error mirroring "${ecdHotel.name}": ${err.message}`);
  } finally {
    result.loadTimeMs = Date.now() - t0;
    try {
      const shot = await screenshotter.takeStep(
        page, runId, `mirror-${ecdHotel.name.replace(/\s+/g, '_').slice(0, 40)}`
      );
      if (shot) result.screenshotPath = shot;
    } catch { /* ignore */ }
  }

  return result;
}

module.exports = { mirrorEcdHotel };
