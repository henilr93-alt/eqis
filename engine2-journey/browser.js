const { chromium } = require('playwright');
const settings = require('../config/settings');
const logger = require('../utils/logger');

async function launch(opts = {}) {
  const headless = opts.headed === true ? false : settings.HEADLESS;
  logger.info(`[BROWSER] Launching Chromium (headless: ${headless})`);
  const browser = await chromium.launch({
    headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: 'en-IN',
    timezoneId: settings.TIMEZONE,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    permissions: ['clipboard-read', 'clipboard-write'],
  });

  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  logger.info('[BROWSER] Browser ready');
  return { browser, page };
}

module.exports = { launch };
