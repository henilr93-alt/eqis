const { chromium } = require('playwright');
const settings = require('../config/settings');
const logger = require('../utils/logger');
const retry = require('../utils/retry');
const { markOtpUsed, getOtpForService } = require('../dashboard/api/otpApi');

class ZipyLoginError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZipyLoginError';
  }
}

/**
 * Poll the OTP store until a fresh (unused, unexpired) Zipy OTP appears.
 * Waits up to maxWaitMs, checking every pollIntervalMs.
 */
async function waitForOtp(maxWaitMs = 120000, pollIntervalMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const code = getOtpForService('zipy');
    if (code) return code;
    logger.info(`[ZIPY-LOGIN] Waiting for OTP in store... (${Math.round((Date.now() - start) / 1000)}s elapsed)`);
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }
  return null;
}

async function connect() {
  return retry(async () => {
    logger.info(`[ZIPY-LOGIN] Launching browser for ${settings.ZIPY_BASE_URL}`);
    const browser = await chromium.launch({
      headless: settings.HEADLESS,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: 'en-IN',
      timezoneId: settings.TIMEZONE,
    });

    const page = await context.newPage();
    page.setDefaultTimeout(30000);

    // Navigate to Zipy (use domcontentloaded — Zipy SPA has persistent background requests that block networkidle)
    await page.goto(settings.ZIPY_BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Fill email
    const emailSelectors = [
      'input[type="email"]', 'input[name="email"]',
      'input[placeholder*="email" i]', '#email',
    ];

    let emailFilled = false;
    for (const sel of emailSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.fill(settings.ZIPY_EMAIL);
        emailFilled = true;
        logger.info('[ZIPY-LOGIN] Email filled');
        break;
      }
    }

    if (!emailFilled) {
      await browser.close();
      throw new ZipyLoginError('Could not find email field on Zipy login page');
    }

    // Fill password
    const passwordSelectors = [
      'input[type="password"]', 'input[name="password"]', '#password',
    ];

    let passwordFilled = false;
    for (const sel of passwordSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.fill(settings.ZIPY_PASSWORD);
        passwordFilled = true;
        logger.info('[ZIPY-LOGIN] Password filled');
        break;
      }
    }

    if (!passwordFilled) {
      await browser.close();
      throw new ZipyLoginError('Could not find password field on Zipy login page');
    }

    // Click login and wait for navigation to verify-email or dashboard
    const loginSelectors = [
      'button:has-text("Login")', 'button[type="submit"]',
      'button:has-text("Log in")', 'button:has-text("Sign In")',
    ];

    let loginClicked = false;
    for (const sel of loginSelectors) {
      const el = await page.$(sel);
      if (el) {
        // Use Promise.all to catch the navigation triggered by the click
        await Promise.all([
          page.waitForURL(url => !url.toString().includes('sign-in'), { timeout: 15000 }).catch(() => {}),
          el.click(),
        ]);
        loginClicked = true;
        logger.info('[ZIPY-LOGIN] Login button clicked');
        break;
      }
    }

    if (!loginClicked) {
      await browser.close();
      throw new ZipyLoginError('Could not find login button on Zipy login page');
    }

    // Extra settle time for SPA navigation
    await page.waitForTimeout(3000);
    logger.info(`[ZIPY-LOGIN] Post-login URL: ${page.url()}`);

    // Check for OTP prompt (verify-email page)
    const otpSelectors = [
      'input[placeholder*="OTP" i]', 'input[placeholder*="code" i]',
      'input[name*="otp" i]', 'input[type="text"][maxlength="6"]',
      'input[type="number"][maxlength="6"]',
    ];

    let otpField = null;
    for (const sel of otpSelectors) {
      const el = await page.$(sel);
      if (el) {
        otpField = el;
        break;
      }
    }

    if (otpField) {
      logger.info('[ZIPY-LOGIN] OTP prompt detected — polling store for fresh OTP (up to 2 min)...');

      // Poll the OTP store — the OTP was just sent to the user's email by THIS login attempt.
      // The user submits it via the dashboard/CLI, and we pick it up here.
      const otpCode = await waitForOtp(120000, 3000);

      if (!otpCode) {
        await browser.close();
        throw new ZipyLoginError('OTP required but no OTP arrived in store within 2 minutes. Please submit via Settings tab.');
      }

      logger.info(`[ZIPY-LOGIN] Using OTP: ${otpCode}`);
      await otpField.fill(otpCode);

      // Click verify/submit button
      const otpSubmitSelectors = [
        'button:has-text("Verify")', 'button:has-text("Submit")',
        'button[type="submit"]', 'button:has-text("Continue")',
      ];

      for (const submitSel of otpSubmitSelectors) {
        const submitEl = await page.$(submitSel);
        if (submitEl) {
          await submitEl.click();
          logger.info('[ZIPY-LOGIN] OTP verify button clicked');
          break;
        }
      }

      // Mark OTP as used
      markOtpUsed('zipy', otpCode);

      // Wait for auth to complete — Zipy SPA needs time to verify OTP and redirect
      logger.info('[ZIPY-LOGIN] OTP submitted, waiting for authentication...');
      await page.waitForTimeout(5000);
      // Wait for URL to change away from verify-email
      await page.waitForURL(url => !url.toString().includes('verify-email'), { timeout: 15000 }).catch(() => {
        logger.warn('[ZIPY-LOGIN] URL did not change after OTP submit within 15s');
      });
      await page.waitForTimeout(2000);
    }

    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // Verify we got past the auth pages
    const currentUrl = page.url();
    if (currentUrl.includes('verify-email') || currentUrl.includes('sign-in') || currentUrl.includes('login')) {
      logger.error(`[ZIPY-LOGIN] Still on auth page after OTP: ${currentUrl}`);
      await browser.close();
      throw new ZipyLoginError(`Login did not complete — still on ${currentUrl}. OTP may have been invalid or expired.`);
    }
    logger.info(`[ZIPY-LOGIN] Auth passed — now at: ${currentUrl}`);

    // Navigate to Session Replay page (/user-sessions)
    // Zipy sidebar: "Session Replay" link leads to /user-sessions (discovered via DOM exploration)
    const dashUrl = page.url();
    const orgMatch = dashUrl.match(/app\.zipy\.ai\/([^/]+\/[^/]+)\//);
    const orgPath = orgMatch ? orgMatch[1] : null;

    let navSuccess = false;

    // Method 1: Click "Session Replay" in sidebar (MUI ListItem)
    const sidebarLink = await page.$('text=Session Replay');
    if (sidebarLink) {
      await sidebarLink.click();
      await page.waitForTimeout(5000);
      if (page.url().includes('user-sessions')) {
        navSuccess = true;
        logger.info(`[ZIPY-LOGIN] Navigated to Session Replay via sidebar click: ${page.url()}`);
      }
    }

    // Method 2: Direct URL to /user-sessions
    if (!navSuccess && orgPath) {
      const sessionReplayUrl = `https://app.zipy.ai/${orgPath}/user-sessions`;
      logger.info(`[ZIPY-LOGIN] Trying direct Session Replay URL: ${sessionReplayUrl}`);
      await page.goto(sessionReplayUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(5000);
      if (page.url().includes('user-sessions')) {
        navSuccess = true;
        logger.info(`[ZIPY-LOGIN] Navigated to Session Replay via direct URL: ${page.url()}`);
      }
    }

    if (!navSuccess) {
      logger.warn(`[ZIPY-LOGIN] Could not navigate to Session Replay — staying on ${page.url()}`);
    }

    // Wait for MUI table to load (session list uses MuiTableRow components)
    try {
      await page.waitForSelector('[class*="MuiTableRow"], tr', { timeout: 15000 });
      logger.info('[ZIPY-LOGIN] Session table loaded');
    } catch (e) {
      logger.warn('[ZIPY-LOGIN] Session table did not load within 15s — proceeding anyway');
    }
    await page.waitForTimeout(3000);

    // Set time filter to Today (for fresh session data)
    const timeFilterSelectors = [
      'text=Today', 'button:has-text("Today")',
      'text=Yesterday', 'button:has-text("24")',
    ];

    for (const sel of timeFilterSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        await page.waitForTimeout(3000);
        logger.info(`[ZIPY-LOGIN] Time filter set via: ${sel}`);
        break;
      }
    }

    logger.info(`[ZIPY-LOGIN] Login successful, sessions page loaded — ${page.url()}`);
    return { browser, page };
  }, 2, 3000, 'Zipy Login');
}

module.exports = { connect, ZipyLoginError };
