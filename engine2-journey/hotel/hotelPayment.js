const logger = require('../../utils/logger');
const screenshotter = require('../../utils/screenshotter');
const { evaluateStep } = require('../evaluator/visionEval');

async function execute(page, scenario, runId) {
  const stepName = 'hotelPayment';
  const result = { stepName, timestamp: new Date().toISOString(), actions: [] };

  try {
    logger.info('[HOTEL-PAYMENT] Reached hotel payment page — STOPPING HERE (no payment will be made)');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);

    // Screenshot payment page
    const screenshot = await screenshotter.takeStep(page, runId, stepName);

    // Check for booking summary
    const summarySelectors = [
      '.booking-summary', '.reservation-summary', '[class*="summary"]',
      '.hotel-summary', '.order-summary',
    ];

    for (const sel of summarySelectors) {
      const el = await page.$(sel);
      if (el) {
        const text = await el.textContent();
        result.bookingSummary = text?.trim()?.substring(0, 500);
        result.actions.push('Booking summary visible');
        break;
      }
    }

    // Check for cancellation policy
    const cancelSelectors = [
      'text=Cancellation', 'text=cancellation',
      '.cancellation-policy', '[class*="cancel"]',
    ];

    for (const sel of cancelSelectors) {
      const el = await page.$(sel);
      if (el) {
        result.actions.push('Cancellation policy visible');
        break;
      }
    }

    // Evaluate screenshot
    if (screenshot) {
      result.evaluation = await evaluateStep(screenshot, 'hotelPayment', scenario);
    }

    // DO NOT CLICK ANY PAYMENT BUTTON
    result.actions.push('HOTEL JOURNEY COMPLETE — stopped at payment page');
    result.status = 'completed';
    result.journeyComplete = true;
    logger.info('[HOTEL-PAYMENT] Hotel journey COMPLETE — stopped safely at payment');
  } catch (err) {
    logger.error(`[HOTEL-PAYMENT] Failed: ${err.message}`);
    result.status = 'failed';
    result.error = err.message;
    const screenshot = await screenshotter.takeStep(page, runId, `${stepName}_error`);
    if (screenshot) {
      result.evaluation = await evaluateStep(screenshot, 'hotelPayment', scenario);
    }
  }

  return result;
}

module.exports = { execute };
