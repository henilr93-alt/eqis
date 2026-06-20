// reviewEngineTestRun.js — End-to-end Review Pulse smoke test.
// One full search (BOM->DXB INTL), wait for full GDS load (~90s),
// pick first Emirates row, click its Book button, capture what the
// "review" page looks like (URL, load time, errors, screenshot).
//
// This is the SKELETON of engine8-reviewpulse before we split it into
// modules. Run: node scripts/reviewEngineTestRun.js [FROM] [TO] [AIRLINE]

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
const OUT_DIR        = path.join(__dirname, '..', 'reports', 'review');
function ts() { return new Date().toISOString().replace(/[:.]/g, '-'); }

// --- helpers --------------------------------------------------------------

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

async function findAirlineRow(page, airlineLower) {
  return page.evaluate((needle) => {
    const cards = Array.from(document.querySelectorAll('.accordion_container'));
    for (let i = 0; i < cards.length; i++) {
      const t = (cards[i].textContent || '').toLowerCase();
      if (t.indexOf(needle) !== -1 && t.length > 80) {
        cards[i].setAttribute('data-review-pick', '1');
        return { idx: i, snippet: (cards[i].textContent || '').trim().slice(0, 200) };
      }
    }
    return null;
  }, airlineLower);
}

async function captureReviewPage(page, bookClickStart) {
  // Capture metrics + errors on whatever page we ended up on
  const loadMs = Date.now() - bookClickStart;
  const url = page.url();

  const dom = await page.evaluate(() => {
    const errorBanners = [];
    document.querySelectorAll('[class*="error" i], [class*="alert" i], [class*="banner" i]').forEach(el => {
      const t = (el.textContent || '').trim();
      if (t.length > 4 && t.length < 250) errorBanners.push(t.slice(0, 180));
    });
    return {
      url: window.location.href,
      title: document.title,
      bodyTextLen: (document.body && document.body.innerText || '').length,
      hasPassengerForm: !!document.querySelector('input[name*="first" i], input[name*="passenger" i]'),
      hasPriceSummary: !!document.querySelector('[class*="totalPrice" i], [class*="grandTotal" i], [class*="fareSummary" i]'),
      hasBookButton: !!Array.from(document.querySelectorAll('button')).find(b => /book\s*(now)?|continue|confirm|pay/i.test((b.textContent || '').trim())),
      errorBanners: Array.from(new Set(errorBanners)).slice(0, 8),
    };
  });

  return { loadMs, url, ...dom };
}

// --- main -----------------------------------------------------------------

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: settings.HEADLESS !== 'false' });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const report = {
    sector: FROM + '->' + TO,
    targetAirline: TARGET_AIRLINE,
    startedAt: new Date().toISOString(),
    steps: [],
  };

  try {
    console.log('[REVIEW] login...');
    await authenticate(page);
    report.steps.push({ name: 'login', ok: true });

    console.log('[REVIEW] navigating to /flights');
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
    const finalRowCount = await waitForResultsFullyLoaded(page);
    report.steps.push({ name: 'results loaded', ok: true, populatedRows: finalRowCount, resultsUrl: page.url() });
    report.searchResultsUrl = page.url();

    // Find the target airline row
    console.log('[REVIEW] locating ' + TARGET_AIRLINE + ' row...');
    const pick = await findAirlineRow(page, TARGET_AIRLINE);
    if (!pick) {
      report.steps.push({ name: 'pick airline row', ok: false, reason: TARGET_AIRLINE + ' not visible in default results' });
      throw new Error(TARGET_AIRLINE + ' not visible in default results');
    }
    report.targetRow = { idx: pick.idx, snippet: pick.snippet };
    console.log('[REVIEW]  picked row idx=' + pick.idx);
    console.log('[REVIEW]   ' + pick.snippet);

    // Click the picked row to expand its fare options
    console.log('[REVIEW] expanding target row...');
    await page.evaluate(() => {
      const el = document.querySelector('[data-review-pick="1"]');
      if (el) el.scrollIntoView({ block: 'center' });
    });
    await page.waitForTimeout(500);
    await page.click('[data-review-pick="1"]');
    await page.waitForTimeout(2500);

    // Find Book Now button INSIDE the picked row (or its immediate vicinity)
    console.log('[REVIEW] locating Book button on target row...');
    const bookFound = await page.evaluate(() => {
      const target = document.querySelector('[data-review-pick="1"]');
      if (!target) return null;
      // Look for Book Now within target OR its parent container (Etrav sometimes
      // renders Book outside the accordion when expanded)
      const scope = target.parentElement || target;
      const btns = Array.from(scope.querySelectorAll('button'));
      for (const b of btns) {
        const t = (b.textContent || '').trim();
        if (/^book\s*now$/i.test(t)) {
          const r = b.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            b.setAttribute('data-review-book', '1');
            return { tag: b.tagName, text: t, x: Math.round(r.x), y: Math.round(r.y) };
          }
        }
      }
      // Fallback: any "book" element at all in scope
      let leafBook = null;
      scope.querySelectorAll('*').forEach(el => {
        if (el.children.length > 0) return;
        const t = (el.textContent || '').trim();
        if (/^book\s*now$/i.test(t)) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && !leafBook) {
            el.setAttribute('data-review-book', '1');
            leafBook = { tag: el.tagName, text: t, x: Math.round(r.x), y: Math.round(r.y) };
          }
        }
      });
      return leafBook;
    });

    if (!bookFound) {
      report.steps.push({ name: 'find book button', ok: false });
      throw new Error('Could not find Book Now button on target row');
    }
    report.bookButton = bookFound;
    console.log('[REVIEW]  Book button at (' + bookFound.x + ', ' + bookFound.y + ')');

    // Click Book Now → expect either a new tab or in-place navigation
    console.log('[REVIEW] clicking Book Now...');
    const bookClickStart = Date.now();

    let reviewPage = null;
    const newPagePromise = ctx.waitForEvent('page', { timeout: 15000 }).catch(() => null);
    await page.click('[data-review-book="1"]');
    const newPage = await newPagePromise;
    if (newPage) {
      console.log('[REVIEW]  → opened new tab');
      reviewPage = newPage;
      await reviewPage.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    } else {
      console.log('[REVIEW]  → no new tab, navigation in place');
      reviewPage = page;
      await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    }
    await reviewPage.waitForTimeout(2500);
    report.steps.push({ name: 'book click', ok: true, newTabOpened: !!newPage });

    const metrics = await captureReviewPage(reviewPage, bookClickStart);
    report.reviewPage = metrics;
    console.log('[REVIEW] review-page captured:');
    console.log('  URL:           ' + metrics.url);
    console.log('  loadMs:        ' + metrics.loadMs);
    console.log('  title:         ' + metrics.title);
    console.log('  bodyTextLen:   ' + metrics.bodyTextLen);
    console.log('  passengerForm: ' + metrics.hasPassengerForm);
    console.log('  priceSummary:  ' + metrics.hasPriceSummary);
    console.log('  bookButton:    ' + metrics.hasBookButton);
    console.log('  errorBanners:  ' + JSON.stringify(metrics.errorBanners));

    const shotPath = path.join(OUT_DIR, 'review-pulse-test-' + ts() + '.png');
    await reviewPage.screenshot({ path: shotPath, fullPage: true });
    report.screenshot = shotPath;
    console.log('[REVIEW]  screenshot: ' + shotPath);

    const dumpPath = path.join(OUT_DIR, 'review-pulse-test-' + ts() + '.json');
    fs.writeFileSync(dumpPath, JSON.stringify(report, null, 2));
    console.log('[REVIEW]  dump:       ' + dumpPath);

    // Close the review tab if it was new
    if (newPage) await newPage.close().catch(() => {});
  } catch (e) {
    console.error('[REVIEW] failed: ' + e.message);
    report.error = e.message;
    try {
      const errShot = path.join(OUT_DIR, 'review-pulse-test-ERROR-' + ts() + '.png');
      await page.screenshot({ path: errShot, fullPage: true });
      report.errorScreenshot = errShot;
    } catch {}
    fs.writeFileSync(path.join(OUT_DIR, 'review-pulse-test-ERROR-' + ts() + '.json'), JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
  }
})();
