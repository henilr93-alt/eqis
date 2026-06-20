#!/usr/bin/env node
/**
 * Validate v3 pickDmcInputField + full submit. Should now redirect to /hotels/search-results.
 */
const fs = require('fs');
const path = require('path');
const browserModule = require('../utils/etravBrowser');
const { authenticate } = require('../utils/etravLogin');
const { pickHotelDateRange } = require('../utils/etravFormHelpers');

const OUT = path.join(__dirname, '..', 'reports', 'ecd', 'recon-v3-validate-' + Date.now());
fs.mkdirSync(OUT, { recursive: true });

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: false }).catch(() => {});
}

(async () => {
  const { browser, context, page } = await browserModule.launch();
  try {
    console.log('=== Login ===');
    await authenticate(page);
    console.log('  logged in: ' + page.url());

    console.log('\n=== Navigate to /echotel ===');
    await page.goto('https://new.etrav.in/echotel', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3500);
    await shot(page, '01-form');

    // Load the freshly-edited module
    delete require.cache[require.resolve('../engine5-ecd/ecdHotelSearcher')];
    const ecdSearcher = require('../engine5-ecd/ecdHotelSearcher');

    // Test v3 directly — we don't have an exported helper, so re-implement test inline
    console.log('\n=== Picking Indonesia via pickDmcInputField ===');
    const destOk = await page.evaluate(({ id, val }) => {
      const el = document.getElementById(id);
      if (!el) return { ok: false, reason: 'no-input' };
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('keyup', { bubbles: true }));
      return { ok: true, valueNow: el.value };
    }, { id: 'destination', val: 'Indonesia' });
    console.log('  setter result: ' + JSON.stringify(destOk));
    await page.waitForTimeout(1500);
    await shot(page, '02-after-dest-set');

    // Pick autosuggest option
    const pickDest = await page.evaluate(({ val }) => {
      const norm = s => (s || '').trim().toLowerCase();
      const wanted = norm(val);
      const cands = Array.from(document.querySelectorAll('li, [role="option"], [class*="option" i], [class*="suggest" i] > div, [class*="dropdown" i] li, [class*="menu" i] li, [class*="list" i] li, [class*="item" i]'));
      let best = null, score = 0;
      for (const el of cands) {
        if (el.offsetParent === null) continue;
        const t = norm(el.textContent || '');
        if (!t || t.length > 60) continue;
        let s = 0;
        if (t === wanted) s = 3;
        else if (t.startsWith(wanted)) s = 2;
        else if (t.includes(wanted)) s = 1;
        if (s > score) { best = el; score = s; }
      }
      if (best) { best.scrollIntoView({ block: 'center' }); best.click(); return { ok: true, text: best.textContent.trim().slice(0,40), score, candidateCount: cands.length }; }
      return { ok: false, candidateCount: cands.length };
    }, { val: 'Indonesia' });
    console.log('  destination autosuggest pick: ' + JSON.stringify(pickDest));
    await page.waitForTimeout(1500);

    // Read input.value to verify commit
    const destValue = await page.evaluate(() => document.getElementById('destination')?.value);
    console.log('  input#destination.value AFTER pick: "' + destValue + '"');
    await shot(page, '03-after-dest-pick');

    // Now do city
    const cityEnabled = await page.evaluate(() => {
      const el = document.getElementById('city');
      return el ? !el.disabled : null;
    });
    console.log('  city input enabled: ' + cityEnabled);

    const citySetter = await page.evaluate(({ id, val }) => {
      const el = document.getElementById(id);
      if (!el) return { ok: false };
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('keyup', { bubbles: true }));
      return { ok: true };
    }, { id: 'city', val: 'Bali' });
    console.log('  city setter: ' + JSON.stringify(citySetter));
    await page.waitForTimeout(1500);

    const cityPick = await page.evaluate(({ val }) => {
      const norm = s => (s || '').trim().toLowerCase();
      const wanted = norm(val);
      const cands = Array.from(document.querySelectorAll('li, [role="option"], [class*="option" i], [class*="suggest" i] > div, [class*="dropdown" i] li, [class*="menu" i] li, [class*="list" i] li, [class*="item" i]'));
      let best = null, score = 0;
      for (const el of cands) {
        if (el.offsetParent === null) continue;
        const t = norm(el.textContent || '');
        if (!t || t.length > 60) continue;
        let s = 0;
        if (t === wanted) s = 3;
        else if (t.startsWith(wanted)) s = 2;
        else if (t.includes(wanted)) s = 1;
        if (s > score) { best = el; score = s; }
      }
      if (best) { best.scrollIntoView({ block: 'center' }); best.click(); return { ok: true, text: best.textContent.trim().slice(0,40), score }; }
      return { ok: false, candidateCount: cands.length };
    }, { val: 'Bali' });
    console.log('  city pick: ' + JSON.stringify(cityPick));
    await page.waitForTimeout(1000);

    const cityValue = await page.evaluate(() => document.getElementById('city')?.value);
    console.log('  input#city.value AFTER pick: "' + cityValue + '"');
    await shot(page, '04-after-city');

    // Dates
    console.log('\n=== Dates ===');
    const inDate = new Date(); inDate.setDate(inDate.getDate() + 7);
    const outDate = new Date(); outDate.setDate(outDate.getDate() + 12);
    const datesOk = await pickHotelDateRange(page, inDate, outDate).catch(() => false);
    console.log('  dates ok: ' + datesOk);
    await page.waitForTimeout(800);
    await shot(page, '05-after-dates');

    // Submit
    console.log('\n=== Submit ===');
    const beforeUrl = page.url();
    const clicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b =>
        b.offsetParent !== null && /search\s*hotel/i.test((b.textContent || '').trim()) && !b.disabled);
      if (btn) { btn.scrollIntoView({block:'center'}); btn.click(); return { ok: true, text: btn.textContent.trim() }; }
      return { ok: false };
    });
    console.log('  search hotel clicked: ' + JSON.stringify(clicked));

    for (const sec of [2, 5, 10, 20]) {
      await page.waitForTimeout((sec * 1000) - (sec === 2 ? 0 : (sec - [0,2,5,10][[2,5,10,20].indexOf(sec)-1]) * 1000));
      console.log('  T+' + sec + 's URL: ' + page.url());
    }
    await shot(page, '06-after-submit-20s');

    const finalUrl = page.url();
    console.log('\nFINAL URL: ' + finalUrl);
    const passes = /\/hotels(\/search-results)?/.test(new URL(finalUrl).pathname) && !/\/echotel/.test(new URL(finalUrl).pathname);
    console.log('PASSES ENGINE REDIRECT CHECK? ' + (passes ? 'YES ✓' : 'NO ✗'));

    console.log('\nArtifacts: ' + OUT);
  } catch (e) {
    console.error('FAILED: ' + e.stack);
  } finally {
    await browser.close().catch(() => {});
  }
})();
