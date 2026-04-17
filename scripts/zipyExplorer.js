const { chromium } = require('playwright');
const settings = require('../config/settings');
const fs = require('fs');
const path = require('path');

(async () => {
  const reportDir = path.join(__dirname, '..', 'reports/zipy/exploration');
  fs.mkdirSync(reportDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(30000);

  // Login
  await page.goto(settings.ZIPY_BASE_URL, { waitUntil: 'load', timeout: 45000 });
  await page.waitForTimeout(5000);
  try {
    await page.fill('input[type="email"]', settings.ZIPY_EMAIL);
  } catch (e) {
    const inputs = await page.$$('input');
    if (inputs[0]) { await inputs[0].click(); await inputs[0].type(settings.ZIPY_EMAIL, { delay: 30 }); }
  }
  await page.fill('input[type="password"]', settings.ZIPY_PASSWORD);
  await Promise.all([
    page.waitForURL(url => !url.toString().includes('sign-in'), { timeout: 20000 }).catch(() => {}),
    page.click('button:has-text("Login")')
  ]);
  await page.waitForTimeout(5000);

  if (page.url().includes('sign-in') || page.url().includes('verify-email')) {
    console.log('LOGIN BLOCKED:', page.url());
    await browser.close();
    return;
  }
  console.log('Logged in:', page.url());

  // Navigate to /user-sessions
  const orgMatch = page.url().match(/app\.zipy\.ai\/([^/]+\/[^/]+)\//);
  const orgPath = orgMatch ? orgMatch[1] : 'a268074c/7923';
  const sessionUrl = `https://app.zipy.ai/${orgPath}/user-sessions`;
  console.log('\nNavigating to:', sessionUrl);

  await page.goto(sessionUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log('Waiting 20s for session list to load...');
  await page.waitForTimeout(20000);

  await page.screenshot({ path: path.join(reportDir, '04-session-replay-loaded.png') });

  // Deep DOM analysis
  const dom = await page.evaluate(() => {
    const analysis = {
      url: window.location.href,
      bodyTextLength: document.body.innerText.length,
      bodyText: document.body.innerText.substring(0, 1000).replace(/\n+/g, ' | '),
      tables: document.querySelectorAll('table').length,
      rows: document.querySelectorAll('tr, [role="row"]').length,
      tds: document.querySelectorAll('td, [role="cell"]').length,
      listItems: document.querySelectorAll('li, [role="listitem"]').length,
      muiTableRows: document.querySelectorAll('[class*="MuiTableRow"]').length,
      muiTableCells: document.querySelectorAll('[class*="MuiTableCell"]').length,
      muiChips: document.querySelectorAll('[class*="MuiChip"]').length,

      sessionLinks: [...document.querySelectorAll('a')].filter(a =>
        a.href && (a.href.includes('session') || a.href.includes('replay'))
      ).map(a => ({ href: a.href.substring(0, 150), text: a.innerText.trim().substring(0, 60) })).slice(0, 20),

      timeElements: [...document.querySelectorAll('*')].filter(el => {
        const t = el.innerText?.trim();
        return t && (t.match(/^\d+m\s*\d+s$/) || t.match(/^\d+:\d+:\d+$/) || t.match(/^\d+:\d+$/) || t.match(/^\d+\s*sec$/)) && el.children.length === 0;
      }).map(el => ({ text: el.innerText.trim(), tag: el.tagName, class: (el.className || '').substring(0, 80) })).slice(0, 15),

      relevantClasses: (() => {
        const classes = new Set();
        document.querySelectorAll('*').forEach(el => {
          const cls = el.className?.toString?.() || '';
          if (cls.match(/session|replay|user|recording|duration|device|country|browser|pages/i)) {
            cls.split(/\s+/).forEach(c => {
              if (c.match(/session|replay|user|recording|duration|device|country|browser|pages/i)) classes.add(c);
            });
          }
        });
        return [...classes].slice(0, 30);
      })(),

      // Get all divs that look like session row entries (in main content, not sidebar)
      potentialSessionRows: (() => {
        // Look for repeated div patterns that might be session items
        const allDivs = document.querySelectorAll('div');
        const candidates = [];
        for (const div of allDivs) {
          const text = div.innerText || '';
          // Session rows typically contain: country flag/name, duration, pages, device, time
          if (text.length > 20 && text.length < 500 &&
              (text.includes('page') || text.includes('sec') || text.includes('min') || text.match(/\d+:\d+/)) &&
              div.children.length >= 2 && div.children.length <= 20) {
            candidates.push({
              class: (div.className || '').substring(0, 100),
              childCount: div.children.length,
              text: text.substring(0, 150),
              rect: div.getBoundingClientRect()
            });
          }
        }
        // Filter to divs in the main content area (x > 240, not sidebar)
        return candidates.filter(c => c.rect.x > 240 && c.rect.width > 400).slice(0, 10);
      })()
    };
    return analysis;
  });

  console.log('\n=== SESSION REPLAY PAGE — FULL ANALYSIS ===');
  console.log('URL:', dom.url);
  console.log('Body text:', dom.bodyTextLength, 'chars');
  console.log('\nElements: tables=' + dom.tables, 'rows=' + dom.rows, 'tds=' + dom.tds, 'muiTableRows=' + dom.muiTableRows, 'muiTableCells=' + dom.muiTableCells);
  console.log('\nSession links (' + dom.sessionLinks.length + '):');
  dom.sessionLinks.forEach(l => console.log('  ', l.text || '(no text)', '->', l.href));
  console.log('\nTime elements (' + dom.timeElements.length + '):');
  dom.timeElements.forEach(t => console.log('  ', t.text, '[' + t.tag + ']'));
  console.log('\nRelevant classes:', dom.relevantClasses.join(', '));
  console.log('\nPotential session rows (' + dom.potentialSessionRows.length + '):');
  dom.potentialSessionRows.forEach(r => console.log('  class:', r.class?.substring(0, 60), '| children:', r.childCount, '| text:', r.text.substring(0, 100)));
  console.log('\nBody text preview:', dom.bodyText.substring(0, 500));

  fs.writeFileSync(path.join(reportDir, 'session-replay-full-dom.json'), JSON.stringify(dom, null, 2));

  await browser.close();
  console.log('\n=== DONE ===');
})();
