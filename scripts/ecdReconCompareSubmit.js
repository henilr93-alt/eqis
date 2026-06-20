#!/usr/bin/env node
/**
 * ecdReconCompareSubmit.js — Full E2E submit on BOTH /hotels and /echotel.
 * Captures the EXACT redirect URL after Search Hotel click, plus DOM state
 * at every step, so we can spot what the ECD engine's hardcoded URL check
 * is missing.
 */

const fs = require('fs');
const path = require('path');
const browserModule = require('../utils/etravBrowser');
const { authenticate } = require('../utils/etravLogin');
const settings = require('../config/settings');
const { pickHotelDateRange } = require('../utils/etravFormHelpers');

const OUT_DIR = path.join(__dirname, '..', 'reports', 'ecd', 'recon-submit-' + Date.now());
fs.mkdirSync(OUT_DIR, { recursive: true });

async function dump(page, name) {
  try {
    const html = await page.content();
    fs.writeFileSync(path.join(OUT_DIR, name + '.html'), html);
  } catch {}
  await page.screenshot({ path: path.join(OUT_DIR, name + '.png'), fullPage: false }).catch(() => {});
  console.log('  saved ' + name);
}

// Generic dropdown picker — find a div whose text starts with the label, click it
// to open, then pick first matching option.
async function pickDropdownOpt(page, label, optionText) {
  const res = await page.evaluate(({ label, optionText }) => {
    // Find dropdown trigger by label text
    const all = Array.from(document.querySelectorAll('div, span, button, label, p'));
    const trigger = all.find(e => e.offsetParent !== null && (e.textContent || '').trim().toLowerCase() === label.toLowerCase());
    if (!trigger) return { ok: false, reason: 'trigger-not-found' };
    // Click it to open
    let clickable = trigger;
    // Walk up to find a clickable parent
    for (let i = 0; i < 5 && clickable; i++) {
      const cs = window.getComputedStyle(clickable);
      if (cs.cursor === 'pointer' || clickable.tagName === 'BUTTON' || clickable.onclick) break;
      clickable = clickable.parentElement;
    }
    (clickable || trigger).click();
    return { ok: true, clicked: (clickable || trigger).tagName };
  }, { label, optionText });
  if (!res.ok) return res;
  await page.waitForTimeout(800);

  const pick = await page.evaluate(({ optionText }) => {
    const opts = Array.from(document.querySelectorAll('li, .option, [class*="option"], [role="option"], div'));
    const match = opts.find(o => o.offsetParent !== null && (o.textContent || '').trim().toLowerCase() === optionText.toLowerCase());
    if (match) { match.scrollIntoView(); match.click(); return { ok: true, text: match.textContent.trim() }; }
    // Substring fallback
    const sub = opts.find(o => o.offsetParent !== null && (o.textContent || '').trim().toLowerCase().includes(optionText.toLowerCase()) && (o.textContent || '').trim().length < 80);
    if (sub) { sub.scrollIntoView(); sub.click(); return { ok: true, text: sub.textContent.trim(), match: 'substring' }; }
    return { ok: false };
  }, { optionText });
  return pick;
}

async function clickSearchHotel(page) {
  return page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const btn = buttons.find(b => b.offsetParent !== null && /search\s*hotel/i.test((b.textContent || '').trim()) && !b.disabled);
    if (btn) { btn.scrollIntoView({ block: 'center' }); btn.click(); return { ok: true, text: btn.textContent.trim() }; }
    return { ok: false };
  });
}

async function searchOnTab(page, tabUrl, label) {
  console.log('\n=== Testing tab: ' + label + ' (' + tabUrl + ') ===');
  await page.goto(tabUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3500);
  const prefix = label.toLowerCase().replace(/[^a-z0-9]/g, '-');
  await dump(page, prefix + '-01-loaded');

  // For DMC tab, pick destination + city via dropdowns
  if (/echotel/.test(tabUrl)) {
    console.log('  Picking Indonesia / Bali via dropdowns');
    const d1 = await pickDropdownOpt(page, 'Select Destination', 'Indonesia');
    console.log('    Select Destination → ' + JSON.stringify(d1));
    await page.waitForTimeout(800);
    await dump(page, prefix + '-02-after-dest');
    const d2 = await pickDropdownOpt(page, 'Select City', 'Bali');
    console.log('    Select City → ' + JSON.stringify(d2));
    await page.waitForTimeout(800);
    await dump(page, prefix + '-03-after-city');
  } else {
    // Hotels tab — use the autosuggest input
    console.log('  Filling Hotel destination via autosuggest');
    const input = await page.$('input[placeholder*="Hotel"]').catch(() => null);
    if (input) {
      await input.click();
      await input.type('Bali', { delay: 50 });
      await page.waitForTimeout(1500);
      // pick first suggestion
      const picked = await page.evaluate(() => {
        const sug = Array.from(document.querySelectorAll('li, [class*="suggestion"], [class*="option"]')).find(e => e.offsetParent !== null && /bali/i.test((e.textContent || '').trim()));
        if (sug) { sug.click(); return { ok: true, text: sug.textContent.trim() }; }
        return { ok: false };
      });
      console.log('    Hotels autosuggest pick: ' + JSON.stringify(picked));
    }
    await dump(page, prefix + '-02-after-dest');
  }

  // Pick dates
  console.log('  Picking check-in/check-out dates (7 days out, 5-night stay)');
  const inDate = new Date(); inDate.setDate(inDate.getDate() + 7);
  const outDate = new Date(); outDate.setDate(outDate.getDate() + 12);
  const dateOk = await pickHotelDateRange(page, inDate, outDate).catch(e => false);
  console.log('    dates ok: ' + dateOk);
  await page.waitForTimeout(800);
  await dump(page, prefix + '-04-after-dates');

  // Click search hotel — and capture pre-click URL
  const beforeUrl = page.url();
  console.log('  Pre-submit URL: ' + beforeUrl);
  const clicked = await clickSearchHotel(page);
  console.log('  Search Hotel clicked: ' + JSON.stringify(clicked));

  // Wait + capture URL changes over time
  const checks = [2, 5, 10, 20];
  const urlTimeline = [];
  for (const sec of checks) {
    await page.waitForTimeout((sec * 1000) - (checks.indexOf(sec) === 0 ? 0 : checks[checks.indexOf(sec) - 1] * 1000));
    const cur = page.url();
    urlTimeline.push({ at: sec + 's', url: cur, changed: cur !== beforeUrl });
    console.log('  T+' + sec + 's URL: ' + cur);
  }
  await dump(page, prefix + '-05-after-submit-20s');

  // Inspect the final state
  const finalState = await page.evaluate(() => ({
    url: window.location.href,
    pathname: window.location.pathname,
    search: window.location.search,
    title: document.title,
    bodyTextSample: (document.body.innerText || '').slice(0, 500),
    hasResultCards: !!document.querySelector('[class*="result"], [class*="hotel-card"], [class*="HotelCard"], .card'),
  }));
  console.log('  FINAL URL: ' + finalState.url);
  return { label, beforeUrl, urlTimeline, finalState };
}

(async () => {
  const { browser, context, page } = await browserModule.launch();
  try {
    console.log('=== Logging in to Etrav ===');
    await authenticate(page);
    console.log('  logged in, url: ' + page.url());
    await dump(page, '00-after-login');

    // First: DMC Hotels tab
    const dmcResult = await searchOnTab(page, 'https://new.etrav.in/echotel', 'DMC');
    // Reset to dashboard
    await page.goto('https://new.etrav.in/dashboard', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);
    // Then: Hotels tab
    const hotelsResult = await searchOnTab(page, 'https://new.etrav.in/hotels', 'Hotels');

    const summary = { dmcResult, hotelsResult };
    fs.writeFileSync(path.join(OUT_DIR, 'gap-summary.json'), JSON.stringify(summary, null, 2));

    console.log('\n=== GAP SUMMARY ===');
    console.log('DMC pre-submit: ' + dmcResult.beforeUrl);
    console.log('DMC FINAL    : ' + dmcResult.finalState.url);
    console.log('DMC pathname : ' + dmcResult.finalState.pathname);
    console.log('');
    console.log('Hotels pre-submit: ' + hotelsResult.beforeUrl);
    console.log('Hotels FINAL    : ' + hotelsResult.finalState.url);
    console.log('Hotels pathname : ' + hotelsResult.finalState.pathname);
    console.log('');
    console.log('Engine check is:  /\\/hotels(\\/search-results)?/.test(pathname) && !/\\/echotel/.test(pathname)');
    console.log('DMC final passes engine check?    ' + (/\/hotels(\/search-results)?/.test(dmcResult.finalState.pathname) && !/\/echotel/.test(dmcResult.finalState.pathname)));
    console.log('Hotels final passes engine check? ' + (/\/hotels(\/search-results)?/.test(hotelsResult.finalState.pathname) && !/\/echotel/.test(hotelsResult.finalState.pathname)));
    console.log('\nArtifacts: ' + OUT_DIR);
  } catch (e) {
    console.error('RECON FAILED: ' + e.stack);
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
})();
