#!/usr/bin/env node
/**
 * ecdReconCompareTabs.js — RECON ONLY. Walks BOTH the regular Hotels tab and
 * the DMC Hotels (ex-ECD) tab end-to-end to identify the DOM/flow gap that's
 * breaking the ECD engine after Etrav's 2026-06-18 UI changes.
 *
 * Output: reports/ecd/recon-compare-<ts>/
 *   - hotels-01-nav.{html,png}
 *   - hotels-02-form.{html,png}
 *   - hotels-03-after-submit.{html,png}
 *   - dmc-01-nav.{html,png}
 *   - dmc-02-form.{html,png}
 *   - dmc-03-after-submit.{html,png}
 *   - gap.json   (structured comparison)
 *
 * No engine state touched. Pure read.
 */

const fs = require('fs');
const path = require('path');
const browserModule = require('../utils/etravBrowser');
const { authenticate } = require('../utils/etravLogin');
const logger = require('../utils/logger');
const settings = require('../config/settings');

const OUT_DIR = path.join(__dirname, '..', 'reports', 'ecd', 'recon-compare-' + Date.now());

async function dump(page, name) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const html = await page.content().catch(() => '');
  fs.writeFileSync(path.join(OUT_DIR, name + '.html'), html);
  await page.screenshot({ path: path.join(OUT_DIR, name + '.png'), fullPage: false }).catch(() => {});
  console.log('  saved ' + name + ' (html ' + html.length + 'b)');
}

async function inspectNav(page) {
  return page.evaluate(() => {
    const navLinks = Array.from(document.querySelectorAll('header a, nav a, [class*="nav"] a, [class*="header"] a'));
    const visible = navLinks.filter(a => a.offsetParent !== null && (a.textContent || '').trim());
    const items = visible.slice(0, 30).map(a => ({
      text: (a.textContent || '').trim().slice(0, 50),
      href: a.getAttribute('href') || '',
      classes: a.className.slice(0, 80),
    }));
    return { url: window.location.href, navItems: items };
  });
}

async function inspectFormStructure(page) {
  return page.evaluate(() => {
    const result = {
      url: window.location.href,
      title: document.title,
      inputs: [],
      buttons: [],
      dropdowns: [],
      bodyTextSample: (document.body.innerText || '').slice(0, 600),
    };
    Array.from(document.querySelectorAll('input')).filter(i => i.offsetParent !== null).forEach(i => {
      result.inputs.push({
        name: i.name || '',
        id: i.id || '',
        placeholder: i.placeholder || '',
        type: i.type || '',
        ariaLabel: i.getAttribute('aria-label') || '',
        classes: (i.className || '').slice(0, 80),
      });
    });
    Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent !== null).forEach(b => {
      result.buttons.push({
        text: (b.textContent || '').trim().slice(0, 60),
        disabled: b.disabled,
        classes: (b.className || '').slice(0, 80),
      });
    });
    // Likely dropdowns — react-select / labels with chevrons
    Array.from(document.querySelectorAll('[class*="dropdown"], [class*="select"], [role="combobox"], [role="listbox"]')).filter(d => d.offsetParent !== null).slice(0, 15).forEach(d => {
      result.dropdowns.push({
        text: (d.textContent || '').trim().slice(0, 80),
        role: d.getAttribute('role') || '',
        classes: (d.className || '').slice(0, 80),
      });
    });
    return result;
  });
}

async function walkTab(page, tabName, navTextMatch, hotelsConfig) {
  console.log('\n=== Walking ' + tabName + ' tab ===');
  const prefix = tabName.toLowerCase().replace(/[^a-z0-9]/g, '-');

  // Step 0: dump pre-nav state
  console.log('  [step 0] pre-nav (current page)');
  await dump(page, prefix + '-00-prenav');

  // Step 1: click the nav link to enter this tab
  console.log('  [step 1] clicking nav link matching: ' + navTextMatch);
  const clicked = await page.evaluate((needle) => {
    const lower = needle.toLowerCase();
    const all = Array.from(document.querySelectorAll('a, button, [role="button"], [role="link"], li, span, div'));
    for (const el of all) {
      if (el.offsetParent === null) continue;
      const t = (el.textContent || '').trim().toLowerCase();
      // Exact match preferred over substring
      if (t === lower || (t.length < 30 && t.includes(lower))) {
        el.scrollIntoView({ block: 'center' });
        el.click();
        return { ok: true, text: (el.textContent || '').trim().slice(0, 50), tag: el.tagName };
      }
    }
    return { ok: false };
  }, navTextMatch);
  console.log('  clicked: ' + JSON.stringify(clicked));
  await page.waitForTimeout(3500);
  await dump(page, prefix + '-01-after-nav');

  const navState = await inspectNav(page);
  const formState = await inspectFormStructure(page);
  console.log('  url after nav: ' + navState.url);
  console.log('  inputs found: ' + formState.inputs.length + '  buttons: ' + formState.buttons.length + '  dropdowns: ' + formState.dropdowns.length);

  // Save the structured snapshot
  fs.writeFileSync(path.join(OUT_DIR, prefix + '-01-state.json'), JSON.stringify({ navState, formState }, null, 2));

  // Step 2: if there's a destination input/dropdown, try interacting (only on hotels tabs)
  if (hotelsConfig) {
    console.log('  [step 2] attempting interaction with form');
    // Try to find the first visible text input that looks like destination
    const destSel = formState.inputs.find(i =>
      /destination|city|location|hotel/i.test(i.placeholder + ' ' + i.ariaLabel + ' ' + i.name)
    );
    console.log('  candidate destination input: ' + JSON.stringify(destSel));
    await dump(page, prefix + '-02-form-state');
  }
  return { navState, formState };
}

(async () => {
  const { browser, context, page } = await browserModule.launch();

  try {
    console.log('=== Logging in to Etrav ===');
    await authenticate(page);
    await page.waitForTimeout(2000);
    console.log('logged in — current url: ' + page.url());
    await dump(page, '00-after-login');

    // First: visit /hotels and walk regular Hotels tab
    console.log('\n>>> Navigating to /hotels (regular Hotels tab) <<<');
    await page.goto('https://new.etrav.in/hotels', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => console.log('goto err: ' + e.message));
    await page.waitForTimeout(3500);
    const hotelsResult = await walkTab(page, 'hotels', 'Hotels', true);

    // Reset to home or /flights
    console.log('\n>>> Resetting to /flights between tabs <<<');
    await page.goto('https://new.etrav.in/flights', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2500);

    // Then: visit /echotel and walk DMC tab
    console.log('\n>>> Navigating to /echotel (DMC Hotels tab) <<<');
    await page.goto('https://new.etrav.in/echotel', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => console.log('goto err: ' + e.message));
    await page.waitForTimeout(3500);
    const dmcResult = await walkTab(page, 'dmc', 'DMC Hotels', true);

    // Comparison
    const gap = {
      hotelsUrl: hotelsResult.navState.url,
      dmcUrl: dmcResult.navState.url,
      hotelsInputs: hotelsResult.formState.inputs.length,
      dmcInputs: dmcResult.formState.inputs.length,
      hotelsButtons: hotelsResult.formState.buttons.map(b => b.text).filter(Boolean),
      dmcButtons: dmcResult.formState.buttons.map(b => b.text).filter(Boolean),
      hotelsDropdowns: hotelsResult.formState.dropdowns.map(d => d.text).filter(Boolean),
      dmcDropdowns: dmcResult.formState.dropdowns.map(d => d.text).filter(Boolean),
      hotelsBodyPreview: hotelsResult.formState.bodyTextSample,
      dmcBodyPreview: dmcResult.formState.bodyTextSample,
    };
    fs.writeFileSync(path.join(OUT_DIR, 'gap.json'), JSON.stringify(gap, null, 2));
    console.log('\n=== GAP REPORT ===');
    console.log(JSON.stringify(gap, null, 2));
    console.log('\nAll artifacts saved to: ' + OUT_DIR);
  } catch (e) {
    console.error('RECON FAILED: ' + e.stack);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
})();
