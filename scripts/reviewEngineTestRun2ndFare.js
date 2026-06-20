// reviewEngineTestRun2ndFare.js — Same BOM->DXB Emirates flow but selects
// the 2nd fare option in the list before clicking Book.
// Recon showed EK 503 exposes fares like:
//   1) ₹20,737 (NDC)        ← previous test clicked this default
//   2) ₹23,098 (Publish)    ← this test targets this one
//   3) ₹23,318.98 (Economy Saver)
//   4) ₹28,444 (NDC)
// Strategy:
//   a) Find Emirates row, expand it
//   b) Try clicking "More Fares" if present to reveal the per-fare selector
//   c) Pick the 2nd fare element (selectable card or label or chip)
//   d) Then click Book Now (which now operates on the selected fare)

require('dotenv').config({ override: true });
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const settings = require('../config/settings');
const { authenticate } = require('../engine2-journey/login');
const {
  fillAutosuggest, pickFlightDateRange, selectTripType,
  fillFlightPax, clickSearchFlight,
} = require('../utils/etravFormHelpers');

const FROM           = process.argv[2] || 'BOM';
const TO             = process.argv[3] || 'DXB';
const TARGET_AIRLINE = (process.argv[4] || 'Emirates').toLowerCase();
const TARGET_FARE_IDX = Number(process.argv[5] || 1); // 0-based, 1 = second fare
const OUT_DIR        = path.join(__dirname, '..', 'reports', 'review');
function ts() { return new Date().toISOString().replace(/[:.]/g, '-'); }

async function waitForResultsFullyLoaded(page, maxChecks = 60, settleAfter = 5) {
  console.log('[REVIEW] waiting for results to fully stabilise...');
  let last = -1, stable = 0;
  for (let i = 0; i < maxChecks; i++) {
    const populated = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.accordion_container'))
        .filter(c => {
          const t = (c.textContent || '').trim();
          return t.length > 80 && /\b[A-Z]{2,3}\s*\d{1,4}\b/.test(t);
        }).length;
    });
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    if (populated === last && populated > 0) stable++; else stable = 0;
    last = populated;
    console.log('[REVIEW]  check ' + (i + 1) + ': populated=' + populated + ' stable=' + stable + '/' + settleAfter);
    if (stable >= settleAfter) break;
    await page.waitForTimeout(2000);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1500);
  return last;
}

async function captureReviewPage(page, bookClickStart) {
  const loadMs = Date.now() - bookClickStart;
  const dom = await page.evaluate(() => {
    const errorBanners = [];
    document.querySelectorAll('[class*="error" i], [class*="alert" i]').forEach(el => {
      const t = (el.textContent || '').trim();
      if (t.length > 4 && t.length < 250) errorBanners.push(t.slice(0, 180));
    });
    // Try to read the selected fare price from the review page
    let fareSeen = null;
    const fareCandidates = Array.from(document.querySelectorAll('*')).filter(el => {
      if (el.children.length > 0) return false;
      const t = (el.textContent || '').trim();
      return /^\u20b9[\d,]+(?:\.\d+)?$/.test(t);
    }).map(el => el.textContent.trim());
    if (fareCandidates.length > 0) fareSeen = fareCandidates.slice(0, 8);
    return {
      url: window.location.href,
      title: document.title,
      bodyTextLen: (document.body && document.body.innerText || '').length,
      hasPassengerForm: !!document.querySelector('input[name*="first" i], input[name*="passenger" i]'),
      hasPriceSummary: !!document.querySelector('[class*="totalPrice" i], [class*="grandTotal" i], [class*="fareSummary" i]'),
      hasBookButton: !!Array.from(document.querySelectorAll('button')).find(b => /book\s*(now)?|continue|confirm|pay/i.test((b.textContent || '').trim())),
      errorBanners: Array.from(new Set(errorBanners)).slice(0, 8),
      fareCandidates: fareSeen,
    };
  });
  return { loadMs, ...dom };
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: settings.HEADLESS !== 'false' });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const report = {
    sector: FROM + '->' + TO,
    targetAirline: TARGET_AIRLINE,
    targetFareIdx: TARGET_FARE_IDX,
    startedAt: new Date().toISOString(),
    steps: [],
  };

  try {
    console.log('[REVIEW] login...');
    await authenticate(page);

    await page.goto(settings.ETRAV_BASE_URL.replace(/\/$/, '') + '/flights', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('input[placeholder="Where From ?"]', { timeout: 20000 });
    await selectTripType(page, 'roundtrip').catch(() => {});
    await fillAutosuggest(page, 'Where From ?', FROM);
    await fillAutosuggest(page, 'Where To ?', TO);
    const dep = new Date(); dep.setDate(dep.getDate() + 14);
    const ret = new Date(); ret.setDate(ret.getDate() + 19);
    await pickFlightDateRange(page, dep, ret);
    await fillFlightPax(page, { adults: 1, children: 0, infants: 0 }, 'Economy').catch(() => {});
    await clickSearchFlight(page);
    await page.waitForSelector('.accordion_container', { timeout: 60000 });
    await waitForResultsFullyLoaded(page);

    // Find Emirates row and capture all its fare options BEFORE expanding
    console.log('[REVIEW] enumerating Emirates row fares...');
    const rowInfo = await page.evaluate((needle) => {
      const cards = Array.from(document.querySelectorAll('.accordion_container'));
      for (let i = 0; i < cards.length; i++) {
        const t = (cards[i].textContent || '').toLowerCase();
        if (t.indexOf(needle) !== -1 && t.length > 80) {
          cards[i].setAttribute('data-review-pick', '1');
          const full = (cards[i].textContent || '').trim();
          const fareOpts = [];
          const rx = /\u20b9([\d,]+(?:\.\d+)?)\s*\(([^)]+)\)/g;
          let m;
          while ((m = rx.exec(full)) !== null) {
            fareOpts.push({ price: m[1], label: m[2] });
          }
          return { idx: i, snippet: full.slice(0, 200), fareOpts };
        }
      }
      return null;
    }, TARGET_AIRLINE);
    if (!rowInfo) throw new Error('Target airline row not found');
    console.log('[REVIEW]  Emirates row idx=' + rowInfo.idx);
    console.log('[REVIEW]  fare options in row: ' + JSON.stringify(rowInfo.fareOpts));
    report.targetRow = rowInfo;

    if (rowInfo.fareOpts.length <= TARGET_FARE_IDX) {
      throw new Error('Target fare idx ' + TARGET_FARE_IDX + ' out of range (only ' + rowInfo.fareOpts.length + ' fares)');
    }
    const targetFare = rowInfo.fareOpts[TARGET_FARE_IDX];
    console.log('[REVIEW]  targeting fare: \u20b9' + targetFare.price + ' (' + targetFare.label + ')');
    report.targetFare = targetFare;

    // Expand the row (click to open fare selector)
    console.log('[REVIEW] expanding target row...');
    await page.evaluate(() => {
      const el = document.querySelector('[data-review-pick="1"]');
      if (el) el.scrollIntoView({ block: 'center' });
    });
    await page.waitForTimeout(500);
    await page.click('[data-review-pick="1"]');
    await page.waitForTimeout(2500);

    // Look for "More Fares" inside the row and click it to reveal the fare selector
    console.log('[REVIEW] looking for More Fares link...');
    const moreFaresFound = await page.evaluate(() => {
      const target = document.querySelector('[data-review-pick="1"]');
      if (!target) return false;
      const all = Array.from(target.querySelectorAll('*'));
      for (const el of all) {
        if (el.children.length > 0) continue;
        const t = (el.textContent || '').trim();
        if (/^more\s*fares$/i.test(t)) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            el.setAttribute('data-review-morefares', '1');
            return true;
          }
        }
      }
      return false;
    });
    if (moreFaresFound) {
      console.log('[REVIEW]  clicking More Fares...');
      await page.click('[data-review-morefares="1"]');
      await page.waitForTimeout(2000);
    } else {
      console.log('[REVIEW]  no More Fares element found (might already be expanded)');
    }

    // Find a clickable element whose text contains the target fare's price AND label
    console.log('[REVIEW] selecting fare option in expanded view...');
    const fareSelected = await page.evaluate(function(target) {
      const targetPriceText = '\u20b9' + target.price;
      const targetLabelLower = target.label.toLowerCase();
      const root = document.querySelector('[data-review-pick="1"]') || document.body;

      // Strategy 1: find an element containing BOTH price + label as leaf
      const all = Array.from(root.querySelectorAll('*'));
      const candidates = [];
      for (const el of all) {
        const t = (el.textContent || '').trim();
        // Heuristic: contained price + the label, not too large
        if (t.length > 250) continue;
        if (t.indexOf(targetPriceText) === -1) continue;
        if (t.toLowerCase().indexOf(targetLabelLower) === -1) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        // Prefer the smallest matching element (tightest container)
        candidates.push({ el: el, area: r.width * r.height, depth: 0 });
      }
      candidates.sort(function(a, b) { return a.area - b.area; });
      if (candidates.length === 0) return { ok: false, reason: 'no element contains both price + label' };
      const winner = candidates[0].el;
      winner.setAttribute('data-review-fare-pick', '1');
      return {
        ok: true,
        tag: winner.tagName,
        text: (winner.textContent || '').trim().slice(0, 120),
        cls: (winner.className || '').toString().slice(0, 80),
      };
    }, targetFare);

    console.log('[REVIEW]  fare selection target: ' + JSON.stringify(fareSelected));
    if (fareSelected.ok) {
      try {
        await page.click('[data-review-fare-pick="1"]');
        console.log('[REVIEW]  clicked fare option');
        await page.waitForTimeout(1500);
      } catch (e) { console.log('[REVIEW]  fare click failed: ' + e.message); }
    }
    report.fareSelected = fareSelected;

    // Now find Book Now button
    console.log('[REVIEW] locating Book Now button...');
    const bookFound = await page.evaluate(() => {
      const target = document.querySelector('[data-review-pick="1"]') || document.body;
      const scope = target.parentElement || target;
      const btns = Array.from(scope.querySelectorAll('button'));
      for (const b of btns) {
        const t = (b.textContent || '').trim();
        if (/^book\s*now$/i.test(t)) {
          const r = b.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            b.setAttribute('data-review-book', '1');
            return { tag: b.tagName, text: t };
          }
        }
      }
      // fallback: any leaf with 'Book Now' text
      let leafBook = null;
      scope.querySelectorAll('*').forEach(el => {
        if (el.children.length > 0) return;
        const t = (el.textContent || '').trim();
        if (/^book\s*now$/i.test(t)) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && !leafBook) {
            el.setAttribute('data-review-book', '1');
            leafBook = { tag: el.tagName, text: t };
          }
        }
      });
      return leafBook;
    });
    if (!bookFound) throw new Error('Could not find Book Now button after fare selection');
    report.bookButton = bookFound;
    console.log('[REVIEW]  Book button: ' + JSON.stringify(bookFound));

    console.log('[REVIEW] clicking Book Now...');
    const bookClickStart = Date.now();
    let reviewPage = null;
    const newPagePromise = ctx.waitForEvent('page', { timeout: 15000 }).catch(() => null);
    await page.click('[data-review-book="1"]');
    const newPage = await newPagePromise;
    if (newPage) {
      reviewPage = newPage;
      await reviewPage.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
      console.log('[REVIEW]  → new tab opened');
    } else {
      reviewPage = page;
      await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
      console.log('[REVIEW]  → navigated in same tab');
    }
    await reviewPage.waitForTimeout(2500);

    const metrics = await captureReviewPage(reviewPage, bookClickStart);
    report.reviewPage = metrics;
    console.log('[REVIEW] review-page captured:');
    console.log('  URL:           ' + metrics.url);
    console.log('  loadMs:        ' + metrics.loadMs);
    console.log('  fares on page: ' + JSON.stringify(metrics.fareCandidates));
    console.log('  passengerForm: ' + metrics.hasPassengerForm);
    console.log('  priceSummary:  ' + metrics.hasPriceSummary);

    const shotPath = path.join(OUT_DIR, 'review-pulse-fare2-' + ts() + '.png');
    await reviewPage.screenshot({ path: shotPath, fullPage: true });
    report.screenshot = shotPath;
    console.log('[REVIEW]  screenshot: ' + shotPath);

    const dumpPath = path.join(OUT_DIR, 'review-pulse-fare2-' + ts() + '.json');
    fs.writeFileSync(dumpPath, JSON.stringify(report, null, 2));
    console.log('[REVIEW]  dump:       ' + dumpPath);

    if (newPage) await newPage.close().catch(() => {});
  } catch (e) {
    console.error('[REVIEW] failed: ' + e.message);
    report.error = e.message;
    try {
      const errShot = path.join(OUT_DIR, 'review-pulse-fare2-ERROR-' + ts() + '.png');
      await page.screenshot({ path: errShot, fullPage: true });
      report.errorScreenshot = errShot;
    } catch {}
    fs.writeFileSync(path.join(OUT_DIR, 'review-pulse-fare2-ERROR-' + ts() + '.json'), JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
  }
})();
