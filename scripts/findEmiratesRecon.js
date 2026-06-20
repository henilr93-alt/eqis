// findEmiratesRecon.js — same BOM->DXB search, but scroll the results list,
// enumerate ALL airlines present, then dump Emirates-specific rows.

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
function ts() { return new Date().toISOString().replace(/[:.]/g, '-'); }

async function dumpRow(rowHandle) {
  return rowHandle.evaluate((row) => {
    const text = (row.textContent || '').trim();
    const firstLine = text.split('\n').map(s => s.trim()).filter(Boolean)[0] || '';
    // Airline = leading token until we hit a flight-code pattern
    const m = firstLine.match(/^([A-Z][A-Za-z\s\-&\.']{1,30}?)([A-Z0-9]{2,3}\s*\d{1,4})/);
    const airline = m ? m[1].trim() : firstLine.split('|')[0].trim();
    const flightCode = m ? m[2].trim() : '';
    const fareOpts = [];
    const fareRx = /\u20b9([\d,]+)\s*\(([^)]+)\)/g;
    let mm;
    while ((mm = fareRx.exec(text)) !== null) {
      fareOpts.push({ price: mm[1], label: mm[2] });
    }
    return {
      airline, flightCode,
      firstLine: firstLine.slice(0, 200),
      fareOpts,
      hasBookButton: /book\s*now/i.test(text),
      isEmirates: /emirates/i.test(firstLine) || /\bEK\s*\d/.test(text),
    };
  });
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: settings.HEADLESS !== 'false' });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const recon = { from: FROM, to: TO, startedAt: new Date().toISOString() };

  try {
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
    // 2026-06-13: Etrav progressively loads airlines from multiple GDS sources.
    // Initial render shows fast LCC carriers; full-service carriers (Emirates,
    // Etihad, Qatar) trickle in over 20-60 seconds. Wait for results to FULLY
    // load by polling until the populated row count stops growing for 10s.
    console.log('[RECON] polling until result set stabilises...');
    let last = -1, stableCount = 0, totalChecks = 0;
    while (stableCount < 5 && totalChecks < 60) {
      const populated = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('.accordion_container'))
          .filter(c => {
            const t = (c.textContent || '').trim();
            return t.length > 80 && /\b[A-Z]{2,3}\s*\d{1,4}\b/.test(t);
          }).length;
      });
      // Also scroll incrementally to trigger any lazy-mount
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      if (populated === last && populated > 0) {
        stableCount++;
      } else {
        stableCount = 0;
      }
      last = populated;
      totalChecks++;
      console.log('[RECON]  check ' + totalChecks + ': populated=' + populated + '  stable=' + stableCount + '/5');
      await page.waitForTimeout(2000);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1500);

    // 2026-06-13: apply the Etrav Airlines filter to keep ONLY Emirates,
    // so we can confirm the carrier is reachable on this sector even when
    // it isn't price-competitive in the default top-10 view.
    console.log('[RECON] opening Airlines filter pill...');
    try {
      // The filter pill text is "Airlines" — find a button/clickable element
      const airlinesPill = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('button, div, span'));
        for (const el of els) {
          const t = (el.textContent || '').trim();
          if (t === 'Airlines' && el.children.length === 0) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              // Mark it so we can find it from outside
              el.setAttribute('data-recon-pill', 'airlines');
              return { tag: el.tagName, cls: (el.className || '').toString().slice(0, 80) };
            }
          }
        }
        return null;
      });
      console.log('[RECON]  airlines pill: ' + JSON.stringify(airlinesPill));
      if (airlinesPill) {
        await page.click('[data-recon-pill="airlines"]');
        await page.waitForTimeout(1500);
      }
    } catch (e) { console.log('[RECON]  open pill failed: ' + e.message); }

    // Look for Emirates checkbox in the opened dropdown
    console.log('[RECON] searching for Emirates option in filter dropdown...');
    const emiratesPick = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('label, button, div, span, li'));
      for (const el of els) {
        const t = (el.textContent || '').trim();
        if (/^emirates(\s|$)/i.test(t) && t.length < 60) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            el.setAttribute('data-recon-pick', 'emirates');
            return { tag: el.tagName, text: t, cls: (el.className || '').toString().slice(0, 80) };
          }
        }
      }
      return null;
    });
    console.log('[RECON]  emirates option: ' + JSON.stringify(emiratesPick));
    if (emiratesPick) {
      try {
        await page.click('[data-recon-pick="emirates"]');
        await page.waitForTimeout(800);
      } catch (e) { console.log('[RECON]  click emirates failed: ' + e.message); }
    }

    // Click any Apply button if present
    try {
      const applied = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        for (const b of btns) {
          const t = (b.textContent || '').trim();
          if (/^(apply|done|ok)$/i.test(t)) {
            b.setAttribute('data-recon-apply', '1');
            return true;
          }
        }
        return false;
      });
      if (applied) {
        await page.click('[data-recon-apply="1"]');
        console.log('[RECON]  applied filter');
      }
    } catch {}

    // Re-wait for results to stabilise after filter
    console.log('[RECON] re-polling after Emirates filter...');
    await page.waitForTimeout(3000);
    let last2 = -1, stable2 = 0, checks2 = 0;
    while (stable2 < 4 && checks2 < 25) {
      const pop = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('.accordion_container'))
          .filter(c => {
            const t = (c.textContent || '').trim();
            return t.length > 80 && /\b[A-Z]{2,3}\s*\d{1,4}\b/.test(t);
          }).length;
      });
      if (pop === last2) stable2++; else stable2 = 0;
      last2 = pop;
      checks2++;
      console.log('[RECON]  post-filter check ' + checks2 + ': populated=' + pop + '  stable=' + stable2 + '/4');
      await page.waitForTimeout(2000);
    }

    const cards = page.locator('.accordion_container');
    const total = await cards.count();
    console.log('[RECON] total result containers after Emirates filter: ' + total);
    recon.totalResultRows = total;

    // Enumerate every airline visible
    const airlineCounts = {};
    const allRows = [];
    for (let i = 0; i < total; i++) {
      const h = await cards.nth(i).elementHandle();
      if (!h) continue;
      const d = await dumpRow(h);
      allRows.push({ idx: i, ...d });
      const a = (d.airline || '').replace(/\s+/g, ' ').trim().slice(0, 30);
      if (a) airlineCounts[a] = (airlineCounts[a] || 0) + 1;
    }
    recon.airlineCounts = airlineCounts;
    console.log('[RECON] airline distribution:');
    Object.entries(airlineCounts).sort((a, b) => b[1] - a[1]).forEach(([a, n]) => {
      console.log('  ' + n + 'x  ' + a);
    });

    const emiratesRows = allRows.filter(r => r.isEmirates);
    recon.emiratesRows = emiratesRows;
    console.log('[RECON] Emirates rows found: ' + emiratesRows.length);
    emiratesRows.slice(0, 4).forEach((r, i) => {
      console.log('  [' + i + '] ' + r.firstLine.slice(0, 160));
      console.log('       fareOpts: ' + JSON.stringify(r.fareOpts));
    });

    // If we found Emirates rows, click the first one to expand and capture
    // the expanded fare-class structure.
    if (emiratesRows.length > 0) {
      console.log('[RECON] expanding first Emirates row...');
      const firstEmIdx = emiratesRows[0].idx;
      const eh = await cards.nth(firstEmIdx).elementHandle();
      try {
        await eh.scrollIntoViewIfNeeded();
        await eh.click();
        await page.waitForTimeout(2500);
      } catch (e) {
        console.log('[RECON] expand click failed: ' + e.message);
      }

      // Dump the post-expand neighbourhood: any Book buttons or fare labels
      const expanded = await page.evaluate((idx) => {
        const cards = document.querySelectorAll('.accordion_container');
        const target = cards[idx];
        if (!target) return null;
        const surroundingText = (target.textContent || '').trim();
        const buttons = [];
        target.querySelectorAll('button').forEach(b => {
          const t = (b.textContent || '').trim();
          if (t && t.length < 60) buttons.push({ text: t, cls: (b.className || '').toString().slice(0, 80) });
        });
        // Discover sibling-or-child Book Now's that may be tied per fare
        const inlineBookGroups = [];
        target.querySelectorAll('*').forEach(el => {
          if (el.children.length > 0) return;
          const t = (el.textContent || '').trim();
          if (/^book\s*now$/i.test(t)) {
            const r = el.getBoundingClientRect();
            inlineBookGroups.push({
              text: t,
              cls: (el.parentElement && el.parentElement.className) ? el.parentElement.className.toString().slice(0, 80) : '',
              left: Math.round(r.left), top: Math.round(r.top),
            });
          }
        });
        return {
          textLen: surroundingText.length,
          textHead: surroundingText.slice(0, 600),
          textTail: surroundingText.slice(-600),
          buttons: buttons.slice(0, 20),
          inlineBookGroups: inlineBookGroups.slice(0, 12),
        };
      }, firstEmIdx);
      recon.firstEmiratesExpanded = expanded;
      if (expanded) {
        console.log('[RECON] Emirates expanded textLen=' + expanded.textLen + '  Book buttons inline=' + expanded.inlineBookGroups.length);
      }

      const shotPath = path.join(OUT_DIR, 'emirates-expanded-' + ts() + '.png');
      await page.screenshot({ path: shotPath, fullPage: false });
      recon.screenshotExpanded = shotPath;
      console.log('[RECON] expanded screenshot: ' + shotPath);
    } else {
      console.log('[RECON] no Emirates rows in default results — would need airline filter');
    }

    const dumpPath = path.join(OUT_DIR, 'emirates-recon-' + ts() + '.json');
    fs.writeFileSync(dumpPath, JSON.stringify(recon, null, 2));
    console.log('[RECON] dump: ' + dumpPath);
  } catch (e) {
    console.error('[RECON] failed: ' + e.message);
    recon.error = e.message;
    fs.writeFileSync(path.join(OUT_DIR, 'emirates-recon-ERROR-' + ts() + '.json'), JSON.stringify(recon, null, 2));
  } finally {
    await browser.close();
  }
})();
