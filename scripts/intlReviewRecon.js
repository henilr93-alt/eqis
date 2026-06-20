// intlReviewRecon.js — One-shot DOM recon for the Etrav INTL flight-results
// page, to learn the exact selectors the Review Pulse engine will need:
//   * how to enumerate (airline, flight code, fare classes) per result row
//   * where the Book button lives + how fares expand
//   * what the page looks like after clicking Book (review page)
//
// Saves a JSON dump + a fullPage screenshot under reports/recon/ for later
// reference when building engine8-reviewpulse.
//
// Usage: node scripts/intlReviewRecon.js [FROM] [TO]
//   defaults: BOM -> DXB, 14 days out, 1 adult, Economy, one-way

require('dotenv').config({ override: true });
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const settings = require('../config/settings');
const { authenticate } = require('../engine2-journey/login');
const {
  fillAutosuggest,
  pickFlightDateRange,
  selectTripType,
  fillFlightPax,
  clickSearchFlight,
} = require('../utils/etravFormHelpers');

const FROM = process.argv[2] || 'BOM';
const TO   = process.argv[3] || 'DXB';
const OUT_DIR = path.join(__dirname, '..', 'reports', 'recon');

function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function dumpFlightResultRow(rowHandle) {
  return rowHandle.evaluate((row) => {
    // First text line — Etrav format: "Airline | FLIGHT_NUM ..."
    const text = (row.textContent || '').trim();
    const firstLine = text.split('\n').map(s => s.trim()).filter(Boolean)[0] || '';
    const airline   = firstLine.split('|')[0].trim();
    const flightHint = (firstLine.match(/\b[A-Z0-9]{1,3}\s*\d{1,4}\b/) || [''])[0].trim();

    // All <img> srcs (airline logo carries the IATA code, e.g. EK.png)
    const imgs = Array.from(row.querySelectorAll('img'))
      .map(i => i.src).filter(Boolean).slice(0, 4);

    // All <button> labels visible in this row
    const buttons = Array.from(row.querySelectorAll('button'))
      .map(b => (b.textContent || '').trim()).filter(t => t && t.length < 50).slice(0, 8);

    // Look for fare-class indicators that often live as text inside the row
    const fareClassTokens = ['Saver','Saver Plus','Flexi','Flex','Flex+','Lite','Value','Premium','Business','Eco','Economy','Special','Corporate','Smart','Comfort','Refundable'];
    const fareClassesSeen = [];
    fareClassTokens.forEach(t => {
      const rx = new RegExp('\\b' + t.replace(/\+/g, '\\+') + '\\b', 'i');
      if (rx.test(text)) fareClassesSeen.push(t);
    });

    // Possible expand/fare-detail panels nested inside the row
    const subTables = row.querySelectorAll('table').length;
    const collapsibleChildren = row.querySelectorAll('[class*="collapse" i], [class*="expand" i], [aria-expanded]').length;

    // Any element with text exactly "Book" or "Book Now"
    const bookableHits = [];
    row.querySelectorAll('*').forEach(el => {
      const t = (el.textContent || '').trim();
      if (/^book(\s*now)?$/i.test(t) && el.children.length === 0) {
        bookableHits.push({
          tag: el.tagName,
          cls: el.className && el.className.toString ? el.className.toString().slice(0, 80) : '',
        });
      }
    });

    return {
      firstLine: firstLine.slice(0, 120),
      airlineGuess: airline,
      flightHint,
      imgs,
      buttons,
      fareClassesSeen,
      subTables,
      collapsibleChildren,
      bookableHits: bookableHits.slice(0, 5),
    };
  });
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: settings.HEADLESS !== 'false',
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const recon = { from: FROM, to: TO, startedAt: new Date().toISOString(), steps: [] };

  try {
    console.log('[RECON] login...');
    await authenticate(page);
    recon.steps.push({ step: 'login', ok: true, url: page.url() });

    console.log('[RECON] goto /flights');
    await page.goto(settings.ETRAV_BASE_URL.replace(/\/$/, '') + '/flights', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('input[placeholder="Where From ?"]', { timeout: 20000 });
    recon.steps.push({ step: 'reached /flights', ok: true, url: page.url() });

    console.log('[RECON] round-trip (date picker is range-based)');
    await selectTripType(page, 'roundtrip').catch(() => {});

    console.log('[RECON] origin = ' + FROM);
    const okFrom = await fillAutosuggest(page, 'Where From ?', FROM);
    console.log('[RECON] destination = ' + TO);
    const okTo   = await fillAutosuggest(page, 'Where To ?', TO);
    recon.steps.push({ step: 'autosuggest', ok: okFrom && okTo, from: okFrom, to: okTo });

    const dep = new Date(); dep.setDate(dep.getDate() + 14);
    const ret = new Date(); ret.setDate(ret.getDate() + 19);
    console.log('[RECON] dep = ' + dep.toDateString() + ', ret = ' + ret.toDateString());
    const dateOk = await pickFlightDateRange(page, dep, ret);
    recon.steps.push({ step: 'pickDate', ok: !!dateOk, dep: dep.toISOString().slice(0, 10), ret: ret.toISOString().slice(0, 10) });

    console.log('[RECON] pax + cabin');
    await fillFlightPax(page, { adults: 1, children: 0, infants: 0 }, 'Economy').catch(() => {});

    console.log('[RECON] submit search');
    await clickSearchFlight(page);

    console.log('[RECON] waiting for skeleton containers...');
    await page.waitForSelector('.accordion_container', { timeout: 60000 });

    // 2026-06-13: skeleton loaders show up immediately, but real result data
    // takes 10-30s to populate from the airline GDS. Wait until at least one
    // accordion_container has real text (currency, flight number, airline name).
    console.log('[RECON] waiting for real result content to populate...');
    await page.waitForFunction(() => {
      const cards = Array.from(document.querySelectorAll('.accordion_container'));
      // Look for a card whose textContent is meaningfully populated
      const populated = cards.find(c => {
        const t = (c.textContent || '').trim();
        return t.length > 80 && /\b[A-Z]{2,3}\s*\d{1,4}\b/.test(t);
      });
      return !!populated;
    }, { timeout: 60000 }).catch(() => null);
    await page.waitForTimeout(2500);
    recon.steps.push({ step: 'results loaded', ok: true, url: page.url() });

    const cardCount = await page.locator('.accordion_container').count();
    console.log('[RECON] result containers: ' + cardCount);

    // Dump first 5 result rows
    const cards = page.locator('.accordion_container');
    const sampleN = Math.min(cardCount, 5);
    const rowDumps = [];
    for (let i = 0; i < sampleN; i++) {
      const h = await cards.nth(i).elementHandle();
      if (!h) continue;
      const dump = await dumpFlightResultRow(h);
      rowDumps.push({ idx: i, ...dump });
      console.log('[RECON] row[' + i + '] ' + JSON.stringify({
        airline: dump.airlineGuess, flightHint: dump.flightHint,
        buttons: dump.buttons, fareClassesSeen: dump.fareClassesSeen,
      }));
    }
    recon.resultRows = rowDumps;
    recon.totalResultRows = cardCount;

    // Click into the first row to see how Etrav exposes fare classes (expand vs modal)
    console.log('[RECON] clicking first row to discover fare-class UI...');
    try {
      await cards.first().click();
      await page.waitForTimeout(2500);
    } catch (e) {
      recon.steps.push({ step: 'click first row', ok: false, error: e.message });
    }

    // After click: look for the broader DOM signature of expanded fare options
    const afterClick = await page.evaluate(() => {
      // Find newly visible buttons whose text looks bookable
      const bookButtons = [];
      document.querySelectorAll('button').forEach(b => {
        const t = (b.textContent || '').trim();
        if (/^(book|book now|book this|continue|select)$/i.test(t)) {
          const r = b.getBoundingClientRect();
          bookButtons.push({
            text: t,
            cls: (b.className || '').toString().slice(0, 80),
            visible: r.width > 0 && r.height > 0,
          });
        }
      });

      // Hunt for fare-class labels (Saver, Flexi, etc.) in the expanded area
      const fareLabels = [];
      const fareTokenRx = /\b(saver|saver plus|flexi|flex\+|lite|value|premium economy|business|economy plus|smart|comfort|special|refundable)\b/i;
      document.querySelectorAll('div, span, button, label, td, th, h1, h2, h3, h4').forEach(el => {
        if (el.children.length > 0) return;
        const t = (el.textContent || '').trim();
        if (t.length < 2 || t.length > 60) return;
        if (fareTokenRx.test(t)) {
          fareLabels.push({
            text: t.slice(0, 60),
            tag: el.tagName,
            cls: (el.className || '').toString().slice(0, 80),
          });
        }
      });

      // Tables that look like fare-bundle comparison grids
      const fareTables = Array.from(document.querySelectorAll('table'))
        .filter(t => /saver|flexi|business|premium|refund/i.test(t.textContent || ''))
        .map(t => ({ rows: t.rows.length, cols: t.rows[0] ? t.rows[0].cells.length : 0, snippet: (t.textContent || '').replace(/\s+/g, ' ').slice(0, 160) }));

      return {
        bookButtons: bookButtons.slice(0, 10),
        fareLabels: fareLabels.slice(0, 25),
        fareTables: fareTables.slice(0, 4),
        url: window.location.href,
        anyModal: !!document.querySelector('.react-responsive-modal-root, [class*="modal" i]'),
      };
    });
    recon.afterFirstRowClick = afterClick;
    console.log('[RECON] after-click summary: ' + afterClick.bookButtons.length + ' book buttons, ' + afterClick.fareLabels.length + ' fare-class labels, ' + afterClick.fareTables.length + ' fare tables, modal=' + afterClick.anyModal);

    // Screenshot
    const shotPath = path.join(OUT_DIR, 'intl-review-recon-' + ts() + '.png');
    await page.screenshot({ path: shotPath, fullPage: true });
    recon.screenshot = shotPath;
    console.log('[RECON] screenshot: ' + shotPath);

    const dumpPath = path.join(OUT_DIR, 'intl-review-recon-' + ts() + '.json');
    fs.writeFileSync(dumpPath, JSON.stringify(recon, null, 2));
    console.log('[RECON] dump: ' + dumpPath);
  } catch (e) {
    console.error('[RECON] failed: ' + e.message);
    recon.error = e.message;
    try {
      const errShot = path.join(OUT_DIR, 'intl-review-recon-ERROR-' + ts() + '.png');
      await page.screenshot({ path: errShot, fullPage: true });
      recon.errorScreenshot = errShot;
      console.log('[RECON] error screenshot: ' + errShot);
    } catch {}
    fs.writeFileSync(path.join(OUT_DIR, 'intl-review-recon-ERROR-' + ts() + '.json'), JSON.stringify(recon, null, 2));
  } finally {
    await browser.close();
  }
})();
