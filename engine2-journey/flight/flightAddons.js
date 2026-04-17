const logger = require('../../utils/logger');
const screenshotter = require('../../utils/screenshotter');
const { evaluateStep } = require('../evaluator/visionEval');

async function execute(page, scenario, runId) {
  const stepName = 'flightAddons';
  const result = { stepName, timestamp: new Date().toISOString(), actions: [] };

  try {
    logger.info('[FLIGHT-ADDONS] Checking for add-ons page...');
    await page.waitForTimeout(2000);

    // Check if add-ons page is present
    const addonsIndicators = [
      'text=Seat', 'text=Meal', 'text=Baggage',
      'text=Add-ons', 'text=Extras', 'text=Add Ons',
      '.addon-section', '.extras-section', '.ancillary',
    ];

    let addonsFound = false;
    for (const sel of addonsIndicators) {
      const el = await page.$(sel);
      if (el) {
        addonsFound = true;
        break;
      }
    }

    if (!addonsFound) {
      logger.info('[FLIGHT-ADDONS] No add-ons page detected — SKIPPED');
      result.status = 'skipped';
      result.actions.push('Add-ons page not present — skipped');
      return result;
    }

    // Try to select first available seat
    const seatSelectors = [
      '.seat-available:first-of-type',
      '.seat:not(.occupied):first-of-type',
      '[data-seat-status="available"]:first-of-type',
    ];

    for (const sel of seatSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        result.actions.push('Selected seat');
        logger.info('[FLIGHT-ADDONS] Seat selected');
        break;
      }
    }

    await page.waitForTimeout(1000);

    // Try to select first meal option
    const mealSelectors = [
      '.meal-option:first-of-type button',
      '.meal-item:first-of-type .add-btn',
      'button:has-text("Add Meal"):first-of-type',
    ];

    for (const sel of mealSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        result.actions.push('Selected meal');
        logger.info('[FLIGHT-ADDONS] Meal selected');
        break;
      }
    }

    await page.waitForTimeout(1000);

    // Continue / Skip button
    const continueSelectors = [
      'button:has-text("Continue")',
      'button:has-text("Skip")',
      'button:has-text("Proceed")',
      'button:has-text("Next")',
      '.continue-btn',
      '.skip-btn',
    ];

    for (const sel of continueSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        result.actions.push('Clicked continue/skip');
        break;
      }
    }

    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // Screenshot + evaluate
    const screenshot = await screenshotter.takeStep(page, runId, stepName);
    if (screenshot) {
      result.evaluation = await evaluateStep(screenshot, stepName, scenario);
    }

    result.status = 'completed';
    logger.info('[FLIGHT-ADDONS] Step complete');
  } catch (err) {
    logger.error(`[FLIGHT-ADDONS] Failed: ${err.message}`);
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
