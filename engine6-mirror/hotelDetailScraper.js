// hotelDetailScraper.js — Opens a hotel's room-details page (clicked from a
// .listingCard Book Now → opens in new tab) and reads all room categories +
// meal plans + prices.
//
// Confirmed by 2026-05-30 recon (V4):
//   - Book Now opens in a NEW browser tab at `/hotels/room-details?hotelId=...`
//   - Rooms are listed in a <table> with rowspan-grouped rows:
//       <tr> first <td rowspan="N"> contains <h4>{room category}</h4>
//             next <td> contains <h4>{rate variant}</h4><h4>{meal plan}</h4>
//             next <td> contains a div with ₹{price}
//   - Same DOM is used for both bedbank (`isExtranet=` empty) and ECD (`isExtranet=true`).
//
// Page-load gating: a spinner is shown until rooms render. We wait for the
// spinner to disappear AND for at least one ₹ price to be present.

const logger = require('../utils/logger');

const ROOM_LOADED_TIMEOUT_MS = 90000;

function parsePrice(text) {
  if (!text) return null;
  const m = String(text).match(/₹\s*([\d,]+(?:\.\d+)?)/);
  if (m) {
    const n = parseFloat(m[1].replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

async function waitForRoomsLoaded(page, timeoutMs = ROOM_LOADED_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await page.evaluate(() => {
      const spinners = Array.from(document.querySelectorAll(
        '[class*="spinner" i], [class*="loading" i], [class*="loader" i], [class*="circular" i]'
      ));
      const visibleSpinner = spinners.some(s => s.offsetParent !== null);
      const hasPrice = /₹\s*[\d,]+/.test(document.body.innerText || '');
      const hasTable = document.querySelectorAll('table tbody tr').length > 0;
      return !visibleSpinner && hasPrice && hasTable;
    }).catch(() => false);
    if (ready) { await page.waitForTimeout(1500); return true; }
    await page.waitForTimeout(500);
  }
  return false;
}

/**
 * Click the Book Now button on a hotel listing card and return the newly
 * opened tab. Caller is responsible for closing the returned page when done.
 *
 * @param {import('playwright').BrowserContext} context
 * @param {import('playwright').Page} listingPage  the page showing /hotels/search-results
 * @param {string} hotelName  the hotel name to find on the listing
 * @returns {Promise<{newPage: import('playwright').Page|null, error: string|null}>}
 */
async function openHotelDetailTab(context, listingPage, hotelName) {
  let newPage = null;
  const tabPromise = new Promise((resolve) => {
    const handler = (p) => { newPage = p; resolve(p); };
    context.once('page', handler);
    setTimeout(() => resolve(null), 15000);
  });

  const clicked = await listingPage.evaluate((tn) => {
    const cards = Array.from(document.querySelectorAll('.listingCard'));
    if (cards.length === 0) return { found: false, reason: 'no listingCard elements' };
    const tokens = String(tn || '').toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    let bestI = 0, bestScore = 0;
    // If no hotel name passed, default to first card.
    if (tokens.length > 0) {
      bestScore = -1;
      cards.forEach((c, i) => {
        const txt = (c.textContent || '').toLowerCase();
        let s = 0;
        for (const t of tokens) if (txt.includes(t)) s++;
        if (s > bestScore) { bestScore = s; bestI = i; }
      });
      if (bestScore < 1) return { found: false, reason: 'no fuzzy match for "' + tn + '"' };
    }
    const card = cards[bestI];
    card.scrollIntoView({ block: 'center' });
    const btn = card.querySelector('button.bookNow') ||
                Array.from(card.querySelectorAll('button')).find(
                  (b) => /book\s*now/i.test((b.textContent || '').trim())
                );
    if (!btn) return { found: false, reason: 'no Book Now button in matched card' };
    btn.click();
    return { found: true, cardIdx: bestI, score: bestScore };
  }, hotelName);

  if (!clicked.found) {
    return { newPage: null, error: clicked.reason };
  }

  await Promise.race([tabPromise, listingPage.waitForTimeout(12000)]);
  if (!newPage) return { newPage: null, error: 'no new tab opened within 12s' };

  await newPage.waitForLoadState('domcontentloaded').catch(() => {});
  return { newPage, error: null };
}

/**
 * Scrape all room/meal/price combos from an already-loaded hotel detail page.
 * @param {import('playwright').Page} detailPage  at /hotels/room-details?...
 * @returns {Promise<Array<{ roomCategory, mealPlan, totalPrice, currency, refundPolicy, rateName, rawPriceText }>>}
 */
async function extractRoomCombos(detailPage) {
  // Wait for rooms first
  const loaded = await waitForRoomsLoaded(detailPage);
  if (!loaded) {
    logger.warn('[DETAIL] Rooms did not load within timeout');
    return [];
  }

  const rows = await detailPage.evaluate(() => {
    const out = [];
    // Tables on the page that look like room-rate tables (have ₹ inside).
    const tables = Array.from(document.querySelectorAll('table'));
    for (const table of tables) {
      if (!/₹/.test(table.textContent || '')) continue;
      const trs = Array.from(table.querySelectorAll('tbody tr'));
      let currentRoomCategory = '';
      for (const tr of trs) {
        const tds = Array.from(tr.children).filter((c) => c.tagName === 'TD');
        if (tds.length === 0) continue;
        let firstTdIdx = 0;
        // If the first <td> has rowspan, it's the room-category header for the next N rows
        if (tds[0].hasAttribute('rowspan')) {
          const h = tds[0].querySelector('h1,h2,h3,h4,h5');
          currentRoomCategory = (h ? h.textContent : tds[0].textContent || '').trim();
          firstTdIdx = 1;
        }
        // Remaining cells: rate-variant + price + book button
        // Find the dedicated price element — a leaf-ish element whose
        // entire trimmed textContent is just a ₹-number (avoids picking up
        // "1" from "1 Room / 3 Nights" that sits in adjacent divs).
        let priceText = '';
        for (let i = firstTdIdx; i < tds.length; i++) {
          const candidates = tds[i].querySelectorAll('*');
          for (const el of candidates) {
            if (el.children.length > 0) continue;
            const t = (el.textContent || '').trim();
            const m = t.match(/^₹\s*[\d,]+(?:\.\d+)?$/);
            if (m) { priceText = m[0]; break; }
          }
          if (priceText) break;
        }
        if (!priceText) continue;

        // Try to pull meal plan and rate name from h4 elements in middle <td>
        let rateName = '';
        let mealPlan = '';
        if (tds[firstTdIdx]) {
          const headings = Array.from(tds[firstTdIdx].querySelectorAll('h1,h2,h3,h4,h5'))
            .map((h) => (h.textContent || '').trim()).filter(Boolean);
          if (headings.length > 0) rateName = headings[0];
          if (headings.length > 1) mealPlan = headings[1];
        }

        // Refund policy hint
        let refundPolicy = '';
        const refundEl = tr.querySelector('[class*="refund" i], [class*="cancel" i]');
        if (refundEl) refundPolicy = (refundEl.textContent || '').trim();

        out.push({
          roomCategory: currentRoomCategory || rateName,
          mealPlan,
          rateName,
          totalPrice: null,        // parsed in Node
          currency: 'INR',
          rawPriceText: priceText,
          refundPolicy,
        });
      }
    }
    return out;
  });

  return rows.map((r) => ({ ...r, totalPrice: parsePrice(r.rawPriceText) }))
             .filter((r) => r.totalPrice !== null);
}

module.exports = { openHotelDetailTab, extractRoomCombos, waitForRoomsLoaded };
