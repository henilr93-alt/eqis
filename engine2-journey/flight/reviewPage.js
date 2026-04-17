const logger = require('../../utils/logger');
const screenshotter = require('../../utils/screenshotter');
const { evaluateStep } = require('../evaluator/visionEval');

async function execute(page, scenario, runId) {
  const stepName = 'reviewPage';
  const result = { stepName, timestamp: new Date().toISOString(), actions: [] };

  try {
    logger.info('[REVIEW-PAGE] Waiting for review page...');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);

    // Screenshot full review page
    const screenshot = await screenshotter.takeStep(page, runId, stepName);

    // Try to extract pricing info visible on page
    const priceSelectors = [
      '.total-price', '.grand-total', '.fare-total',
      '[class*="total-amount"]', '[class*="payable"]',
    ];

    for (const sel of priceSelectors) {
      const el = await page.$(sel);
      if (el) {
        const text = await el.textContent();
        result.totalPrice = text?.trim();
        result.actions.push(`Total price: ${result.totalPrice}`);
        break;
      }
    }

    // Evaluate screenshot
    if (screenshot) {
      result.evaluation = await evaluateStep(screenshot, stepName, scenario);
    }

    // Click proceed to payment
    const paymentSelectors = [
      'button:has-text("Proceed to Payment")',
      'button:has-text("Continue to Payment")',
      'button:has-text("Pay Now")',
      'button:has-text("Make Payment")',
      'button:has-text("Proceed")',
      'button:has-text("Continue")',
      '.payment-btn',
      '.proceed-btn',
    ];

    for (const sel of paymentSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        result.actions.push('Clicked proceed to payment');
        logger.info('[REVIEW-PAGE] Proceeding to payment...');
        break;
      }
    }

    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    result.status = 'completed';
    logger.info('[REVIEW-PAGE] Step complete');
  } catch (err) {
    logger.error(`[REVIEW-PAGE] Failed: ${err.message}`);
    result.status = 'failed';
    result.error = err.message;
    const screenshot = await screenshotter.takeStep(page, runId, `${stepName}_error`);
    if (screenshot) {
      result.evaluation = await evaluateStep(screenshot, stepName, scenario);
    }
  }

  return result;
}

module.exports = { execute };
