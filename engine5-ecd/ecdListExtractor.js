// ecdListExtractor.js — DOM scraper for the ECD hotels result page.
//
// Strategy: ECD inventory is Eagle Crest's direct-contracted hotels surfaced
// on a dedicated tab/page on new.etrav.in. After a destination + dates + pax
// search, we expect a list of hotel cards, each with one or more room/meal
// combinations and a total stay price (inclusive of taxes).
//
// Selectors below are BEST-GUESS placeholders informed by the patterns visible
// in the existing /hotels search (autosuggest, modal overlays, etc). Phase 0
// recon will lock these to the real DOM.
//
// Output shape:
//   [
//     {
//       ecdHotelId: 'ECD-4421' | null,
//       name: 'Hotel ABC',
//       location: 'Calangute, Goa' | '',
//       combos: [
//         { roomCategory: 'Deluxe Room', mealPlan: 'CP', totalPrice: 14200, currency: 'INR' },
//         ...
//       ]
//     },
//     ...
//   ]

const logger = require('../utils/logger');

// Confirmed by 2026-05-28 recon: each hotel sits in a `.listingCard` box,
// price is in `.currentPrice`. There is ONE price per hotel (no room/meal
// breakdown on the listing page), so the comparison is hotel-level.
function parsePrice(text) {
  if (!text) return null;
  // Pull first ₹-prefixed number — avoids concatenating "1 Room" -> "1"
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
function parseNights(text) {
  const m = String(text || '').match(/(\d+)\s*Night/i);
  return m ? parseInt(m[1], 10) : null;
}
function parseRooms(text) {
  const m = String(text || '').match(/(\d+)\s*Room/i);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Extract ECD hotel cards from the current ECD results page.
 * @param {import('playwright').Page} page
 * @param {number} topCombosPerHotel
 * @returns {Promise<Array>} hotel objects (see file header)
 */
async function extractEcdHotels(page) {
  const hotels = await page.evaluate(() => {
    const out = [];
    const cards = Array.from(document.querySelectorAll('.listingCard'));
    for (const card of cards) {
      // Hotel name
      const nameEl =
        card.querySelector('h1, h2, h3, h4, h5, [class*="hotelName" i], [class*="hotel-name" i], [class*="title" i]') ||
        card.querySelector('strong, b');
      const name = nameEl ? (nameEl.textContent || '').trim() : '';

      // Star rating — look for a small digit (1-7) within any star/rating element.
      // Etrav uses .rating > .ratingValue and similar patterns.
      let starRating = null;
      const starEls = Array.from(card.querySelectorAll(
        '[class*="ratingValue" i], [class*="star" i], [class*="rating" i]'
      ));
      for (const el of starEls) {
        const t = (el.textContent || '').trim();
        const m = t.match(/(?:^|\s)([1-7])(?:\s|$|\.)/);
        if (m) { starRating = parseInt(m[1], 10); break; }
      }

      // Address line
      const addrEl = card.querySelector('[class*="address" i], [class*="location" i]');
      const address = addrEl ? (addrEl.textContent || '').trim() : '';

      // Price
      const priceEl =
        card.querySelector('.currentPrice') ||
        card.querySelector('[class*="currentPrice" i]') ||
        card.querySelector('[class*="priceDetails" i]');
      const priceText = priceEl ? (priceEl.textContent || '').trim() : '';

      // Stay info ("1 Room / 3 Nights")
      const stayInfoEl =
        card.querySelector('[class*="priceDetails" i]') ||
        card.querySelector('[class*="perks" i]') ||
        card;
      const stayText = stayInfoEl ? (stayInfoEl.textContent || '') : '';

      out.push({ name, starRating, address, priceText, stayText });
    }
    return out;
  });

  const parsed = hotels
    .filter((h) => h.name)
    .map((h) => ({
      ecdHotelId: null,
      name: h.name,
      starRating: h.starRating,
      address: h.address,
      combos: [
        {
          roomCategory: '',
          mealPlan: '',
          totalPrice: parsePrice(h.priceText),
          currency: 'INR',
          nights: parseNights(h.stayText),
          rooms: parseRooms(h.stayText),
          rawPriceText: h.priceText,
        },
      ].filter((c) => c.totalPrice !== null),
    }))
    .filter((h) => h.combos.length > 0);

  logger.info('[ECD-EXTRACTOR] Extracted ' + parsed.length + ' ECD hotels from .listingCard');
  return parsed;
}

module.exports = { extractEcdHotels };
