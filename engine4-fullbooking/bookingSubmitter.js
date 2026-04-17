const logger = require('../utils/logger');

async function submit(page, paymentMethod) {
  logger.info(`[BOOKING-SUBMIT] Submitting with payment method: ${paymentMethod}`);

  try {
    // Select payment method based on config
    if (paymentMethod === 'hold') {
      const holdSelectors = [
        'button:has-text("Hold Booking")', 'button:has-text("Book Later")',
        'button:has-text("Hold")', '[data-payment="hold"]',
        'label:has-text("Hold")', 'input[value="hold"]',
      ];
      for (const sel of holdSelectors) {
        const el = await page.$(sel);
        if (el) { await el.click(); logger.info('[BOOKING-SUBMIT] Selected Hold payment'); break; }
      }
    } else if (paymentMethod === 'test_wallet') {
      const walletSelectors = [
        'label:has-text("Wallet")', 'label:has-text("Agent Wallet")',
        '[data-payment="wallet"]', 'input[value="wallet"]',
      ];
      for (const sel of walletSelectors) {
        const el = await page.$(sel);
        if (el) { await el.click(); logger.info('[BOOKING-SUBMIT] Selected Wallet payment'); break; }
      }
    }

    await page.waitForTimeout(1000);

    // Click confirm / book / submit button
    const confirmSelectors = [
      'button:has-text("Confirm Booking")',
      'button:has-text("Book Now")',
      'button:has-text("Complete Booking")',
      'button:has-text("Submit")',
      'button:has-text("Confirm")',
      'button[type="submit"]',
      '.confirm-booking-btn',
    ];

    for (const sel of confirmSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        logger.info('[BOOKING-SUBMIT] Confirm button clicked');
        break;
      }
    }

    // Wait for confirmation page
    await page.waitForLoadState('networkidle', { timeout: 30000 });
    await page.waitForTimeout(3000);

    logger.info('[BOOKING-SUBMIT] Booking submitted, waiting for confirmation...');
    return { success: true };
  } catch (err) {
    logger.error(`[BOOKING-SUBMIT] Failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

module.exports = { submit };
