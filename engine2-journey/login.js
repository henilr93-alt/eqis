const settings = require('../config/settings');
const logger = require('../utils/logger');
const retry = require('../utils/retry');

class EtravLoginError extends Error {
  constructor(message, screenshot) {
    super(message);
    this.name = 'EtravLoginError';
    this.screenshot = screenshot;
  }
}

async function authenticate(page) {
  return retry(async () => {
    logger.info(`[LOGIN] Navigating to ${settings.ETRAV_BASE_URL}`);
    await page.goto(settings.ETRAV_BASE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    // Wait for React SPA to render login form
    await page.waitForSelector('input[type="email"], input[name="email"], input[placeholder*="email" i], input[type="text"]', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // Try common login form selectors — these need to be refined against real DOM
    const emailSelectors = [
      'input[type="email"]',
      'input[name="email"]',
      'input[name="username"]',
      'input[placeholder*="email" i]',
      'input[placeholder*="Email" i]',
      '#email',
      '#username',
    ];

    const passwordSelectors = [
      'input[type="password"]',
      'input[name="password"]',
      '#password',
    ];

    let emailField = null;
    for (const sel of emailSelectors) {
      emailField = await page.$(sel);
      if (emailField) break;
    }

    if (!emailField) {
      const screenshot = await page.screenshot({ encoding: 'base64' });
      throw new EtravLoginError('Could not find email/username field', screenshot);
    }

    await emailField.fill(settings.ETRAV_AGENT_EMAIL);
    logger.info('[LOGIN] Email filled');

    let passwordField = null;
    for (const sel of passwordSelectors) {
      passwordField = await page.$(sel);
      if (passwordField) break;
    }

    if (!passwordField) {
      const screenshot = await page.screenshot({ encoding: 'base64' });
      throw new EtravLoginError('Could not find password field', screenshot);
    }

    await passwordField.fill(settings.ETRAV_AGENT_PASSWORD);
    logger.info('[LOGIN] Password filled');

    // Handle modal overlay if present (etrav uses react-responsive-modal)
    // The login form is inside the modal — click within modal context
    const modalContainer = await page.$('.react-responsive-modal-container, [data-testid="modal-container"]');

    // Try to find and click login/submit button
    const loginButtonSelectors = [
      'button[type="submit"]',
      'button:has-text("Login")',
      'button:has-text("Sign In")',
      'button:has-text("Log In")',
      'input[type="submit"]',
      '.login-btn',
      '#loginBtn',
    ];

    let loginButton = null;
    // Search within modal first if it exists, then page-wide
    const searchContext = modalContainer || page;
    for (const sel of loginButtonSelectors) {
      loginButton = await searchContext.$(sel);
      if (loginButton) break;
    }

    if (!loginButton) {
      const screenshot = await page.screenshot({ encoding: 'base64' });
      throw new EtravLoginError('Could not find login button', screenshot);
    }

    // Use force:true to bypass overlay interception
    await loginButton.click({ force: true });
    logger.info('[LOGIN] Login button clicked, waiting for dashboard...');

    // Wait for navigation after login
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // Verify login success — check if we're no longer on the login page
    const url = page.url();
    if (url.includes('login') || url.includes('signin')) {
      const screenshot = await page.screenshot({ encoding: 'base64' });
      throw new EtravLoginError('Login may have failed — still on login page', screenshot);
    }

    logger.info(`[LOGIN] Login successful — now at: ${url}`);

    // Dismiss any persistent modals that may block subsequent interactions
    await dismissModals(page);
  }, 2, 3000, 'Etrav Login');
}

async function dismissModals(page) {
  const modalCloseSelectors = [
    '.react-responsive-modal-closeButton',
    '[data-testid="modal-container"] button[aria-label="Close"]',
    '.react-responsive-modal-overlay',
    'button.react-responsive-modal-closeButton',
    '[class*="modal-close"]',
    '[class*="close-modal"]',
    'button[aria-label="close"]',
  ];

  for (const sel of modalCloseSelectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click({ force: true });
        await page.waitForTimeout(500);
        logger.info(`[LOGIN] Dismissed modal via: ${sel}`);
      }
    } catch { /* ignore */ }
  }

  // Fallback: press Escape to close any modal
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // Remove all modal elements from DOM entirely (including the root wrapper)
  await page.evaluate(() => {
    const selectors = [
      '.react-responsive-modal-root',
      '.react-responsive-modal-container',
      '.react-responsive-modal-overlay',
      '[data-testid="modal-container"]',
      '[data-testid="root"].react-responsive-modal-root',
    ];
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach(el => el.remove());
    }
  }).catch(() => {});

  logger.info('[LOGIN] Modal cleanup complete');
}

module.exports = { authenticate, EtravLoginError };
