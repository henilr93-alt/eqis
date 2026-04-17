const { chromium } = require('playwright');
const logger = require('../utils/logger');
require('dotenv').config();

/**
 * Zipy OTP Login Handler
 * Navigates to Zipy, enters credentials, waits for OTP prompt
 */
class ZipyOTPLogin {
  constructor() {
    this.browser = null;
    this.page = null;
    this.isLoggedIn = false;
  }

  async initiateBrowser() {
    try {
      this.browser = await chromium.launch({
        headless: false, // Keep visible for OTP entry
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
      
      this.page = await this.browser.newPage();
      await this.page.setViewportSize({ width: 1280, height: 720 });
      
      logger.info('[ZipyOTP] Browser launched for OTP login');
      return true;
    } catch (error) {
      logger.error('[ZipyOTP] Browser launch failed:', error.message);
      return false;
    }
  }

  async navigateToLogin() {
    try {
      logger.info('[ZipyOTP] Navigating to Zipy login page');
      await this.page.goto('https://app.zipy.ai/login', { 
        waitUntil: 'networkidle',
        timeout: 30000 
      });
      
      // Wait for login form to be visible
      await this.page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 10000 });
      logger.info('[ZipyOTP] Login page loaded successfully');
      return true;
    } catch (error) {
      logger.error('[ZipyOTP] Navigation failed:', error.message);
      return false;
    }
  }

  async enterCredentials() {
    try {
      const email = process.env.ZIPY_EMAIL;
      const password = process.env.ZIPY_PASSWORD;
      
      if (!email || !password) {
        logger.error('[ZipyOTP] Missing ZIPY_EMAIL or ZIPY_PASSWORD in .env');
        return false;
      }

      // Find and fill email field
      const emailSelector = 'input[type="email"], input[name="email"], input[placeholder*="email"]';
      await this.page.waitForSelector(emailSelector, { timeout: 5000 });
      await this.page.fill(emailSelector, email);
      logger.info('[ZipyOTP] Email entered');

      // Find and fill password field
      const passwordSelector = 'input[type="password"], input[name="password"]';
      await this.page.waitForSelector(passwordSelector, { timeout: 5000 });
      await this.page.fill(passwordSelector, password);
      logger.info('[ZipyOTP] Password entered');

      // Click login button
      const loginButton = 'button[type="submit"], button:has-text("Login"), button:has-text("Sign in")';
      await this.page.click(loginButton);
      logger.info('[ZipyOTP] Login button clicked');

      return true;
    } catch (error) {
      logger.error('[ZipyOTP] Credential entry failed:', error.message);
      return false;
    }
  }

  async waitForOTPPrompt() {
    try {
      logger.info('[ZipyOTP] Waiting for OTP prompt to appear...');
      
      // Wait for OTP-related elements (common patterns)
      const otpSelectors = [
        'input[placeholder*="OTP"]',
        'input[placeholder*="code"]', 
        'input[name*="otp"]',
        'input[name*="code"]',
        '.otp-input',
        '[data-testid*="otp"]',
        'input[maxlength="6"]'
      ];
      
      // Try each selector with a reasonable timeout
      let otpFound = false;
      for (const selector of otpSelectors) {
        try {
          await this.page.waitForSelector(selector, { timeout: 3000 });
          logger.info(`[ZipyOTP] OTP field found with selector: ${selector}`);
          otpFound = true;
          break;
        } catch (e) {
          // Continue trying other selectors
        }
      }
      
      if (!otpFound) {
        // Fallback: look for any input that might be OTP
        await this.page.waitForTimeout(2000);
        const inputs = await this.page.$$('input');
        if (inputs.length > 0) {
          logger.info('[ZipyOTP] Found input fields, assuming OTP prompt appeared');
          otpFound = true;
        }
      }
      
      if (otpFound) {
        await this.logPageState();
        return true;
      } else {
        logger.error('[ZipyOTP] No OTP prompt detected after login attempt');
        return false;
      }
    } catch (error) {
      logger.error('[ZipyOTP] OTP prompt detection failed:', error.message);
      await this.logPageState(); // Log state even on error
      return false;
    }
  }

  async logPageState() {
    try {
      const url = this.page.url();
      const title = await this.page.title();
      
      // Get all input fields for debugging
      const inputs = await this.page.$$eval('input', elements => 
        elements.map(el => ({
          type: el.type,
          name: el.name,
          placeholder: el.placeholder,
          id: el.id,
          className: el.className
        }))
      );
      
      logger.info('[ZipyOTP] === PAGE STATE ===');
      logger.info(`[ZipyOTP] URL: ${url}`);
      logger.info(`[ZipyOTP] Title: ${title}`);
      logger.info(`[ZipyOTP] Input fields found: ${inputs.length}`);
      inputs.forEach((input, i) => {
        logger.info(`[ZipyOTP] Input ${i + 1}: ${JSON.stringify(input)}`);
      });
      logger.info('[ZipyOTP] === END PAGE STATE ===');
      
      // Take a screenshot for CEO reference
      await this.page.screenshot({ 
        path: `logs/zipy-otp-prompt-${Date.now()}.png`,
        fullPage: true 
      });
      logger.info('[ZipyOTP] Screenshot saved to logs/ for CEO reference');
      
    } catch (error) {
      logger.error('[ZipyOTP] Page state logging failed:', error.message);
    }
  }

  async pauseForManualOTP() {
    logger.info('[ZipyOTP] ========================================');
    logger.info('[ZipyOTP] OTP PROMPT READY - MANUAL INPUT REQUIRED');
    logger.info('[ZipyOTP] Please check the browser window and enter OTP');
    logger.info('[ZipyOTP] Browser will remain open for manual completion');
    logger.info('[ZipyOTP] ========================================');
    
    // Keep browser open and return control
    return {
      success: true,
      message: 'OTP prompt displayed, waiting for manual input',
      browserOpen: true,
      nextStep: 'Manual OTP entry required'
    };
  }

  async cleanup() {
    try {
      if (this.browser) {
        await this.browser.close();
        logger.info('[ZipyOTP] Browser closed');
      }
    } catch (error) {
      logger.error('[ZipyOTP] Cleanup failed:', error.message);
    }
  }

  async executeOTPLogin() {
    try {
      logger.info('[ZipyOTP] Starting Zipy OTP login process');
      
      if (!(await this.initiateBrowser())) return { success: false, error: 'Browser init failed' };
      if (!(await this.navigateToLogin())) return { success: false, error: 'Navigation failed' };
      if (!(await this.enterCredentials())) return { success: false, error: 'Credential entry failed' };
      if (!(await this.waitForOTPPrompt())) return { success: false, error: 'OTP prompt not detected' };
      
      return await this.pauseForManualOTP();
      
    } catch (error) {
      logger.error('[ZipyOTP] Login process failed:', error.message);
      await this.cleanup();
      return { success: false, error: error.message };
    }
  }
}

module.exports = ZipyOTPLogin;

// CLI execution
if (require.main === module) {
  (async () => {
    const otpLogin = new ZipyOTPLogin();
    const result = await otpLogin.executeOTPLogin();
    console.log('OTP Login Result:', result);
    
    if (!result.success) {
      process.exit(1);
    }
  })();
}