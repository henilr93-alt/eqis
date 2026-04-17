const logger = require('../../utils/logger');
const screenshotter = require('../../utils/screenshotter');
const { evaluateStep } = require('../evaluator/visionEval');

async function execute(page, scenario, runId) {
  const stepName = 'paymentPage';
  const result = { stepName, timestamp: new Date().toISOString(), actions: [] };

  try {
    logger.info('[PAYMENT-PAGE] Reached payment page — STOPPING HERE (no payment will be made)');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);

    // Screenshot payment page
    const screenshot = await screenshotter.takeStep(page, runId, stepName);

    // Log visible payment methods
    const paymentMethodSelectors = [
      '.payment-method', '.payment-option', '[class*="payment-type"]',
      '.pay-option', '[data-payment-method]',
    ];

    const methods = [];
    for (const sel of paymentMethodSelectors) {
      const elements = await page.$$(sel);
      for (const el of elements) {
        const text = await el.textContent();
        if (text?.trim()) methods.push(text.trim());
      }
    }

    if (methods.length > 0) {
      result.paymentMethods = methods;
      result.actions.push(`Payment methods visible: ${methods.join(', ')}`);
    }

    // Check for total price on payment page
    const priceSelectors = [
      '.total-price', '.grand-total', '.amount-payable',
      '[class*="total"]', '[class*="payable"]',
    ];

    for (const sel of priceSelectors) {
      const el = await page.$(sel);
      if (el) {
        const text = await el.textContent();
        result.finalPrice = text?.trim();
        result.actions.push(`Final price: ${result.finalPrice}`);
        break;
      }
    }

    // Evaluate screenshot
    if (screenshot) {
      result.evaluation = await evaluateStep(screenshot, stepName, scenario);
    }

    // DO NOT CLICK ANY PAYMENT BUTTON
    result.actions.push('JOURNEY COMPLETE — stopped at payment page');
    result.status = 'completed';
    result.journeyComplete = true;
    logger.info('[PAYMENT-PAGE] Flight journey COMPLETE — stopped safely at payment');
  } catch (err) {
    logger.error(`[PAYMENT-PAGE] Failed: ${err.message}`);
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
