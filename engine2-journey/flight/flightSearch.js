const logger = require('../../utils/logger');
const screenshotter = require('../../utils/screenshotter');
const { evaluateStep } = require('../evaluator/visionEval');
const {
  fillAutosuggest, pickReactDate, selectTripType,
  clickSearchFlight, FLIGHT_RESULT_SELECTOR,
} = require('../../utils/etravFormHelpers');

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

async function execute(page, scenario, runId) {
  const stepName = 'flightSearch';
  const result = { stepName, timestamp: new Date().toISOString(), actions: [] };

  try {
    logger.info(`[FLIGHT-SEARCH] Starting — ${scenario.label}`);

    // Navigate to flights page directly
    await page.goto('https://new.etrav.in/flights', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000); // React SPA needs time to render search form

    // Dismiss any lingering modal
    await page.evaluate(() => {
      ['.react-responsive-modal-root', '.react-responsive-modal-container', '.react-responsive-modal-overlay']
        .forEach(sel => document.querySelectorAll(sel).forEach(el => el.remove()));
    });

    // Select trip type
    await selectTripType(page, scenario.tripType || 'one-way');
    result.actions.push(`Trip type: ${scenario.tripType || 'one-way'}`);

    // Origin
    const originOk = await fillAutosuggest(page, 'Where From ?', scenario.fromCity || scenario.from);
    result.actions.push(`Origin: ${scenario.fromCity || scenario.from} [${originOk ? 'OK' : 'FAIL'}]`);

    // Destination
    const destOk = await fillAutosuggest(page, 'Where To ?', scenario.toCity || scenario.to);
    result.actions.push(`Destination: ${scenario.toCity || scenario.to} [${destOk ? 'OK' : 'FAIL'}]`);

    // Departure date
    const depDate = addDays(new Date(), scenario.dateOffsetDays || 7);
    const depOk = await pickReactDate(page, 0, depDate);
    result.actions.push(`Departure: ${depDate.toDateString()} [${depOk ? 'OK' : 'FAIL'}]`);

    // Return date (if round-trip or open-jaw)
    if ((scenario.tripType === 'round-trip' || scenario.tripType === 'open-jaw') && scenario.returnOffsetDays) {
      const retDate = addDays(new Date(), scenario.returnOffsetDays);
      const retOk = await pickReactDate(page, 1, retDate);
      result.actions.push(`Return: ${retDate.toDateString()} [${retOk ? 'OK' : 'FAIL'}]`);
    }

    await page.waitForTimeout(500);

    // Click search
    const searchClicked = await clickSearchFlight(page);
    result.actions.push(`Search clicked: ${searchClicked}`);

    logger.info('[FLIGHT-SEARCH] Waiting for results...');

    // Wait for real result cards to appear (past skeleton loaders)
    try {
      await page.waitForFunction((sel) => {
        if (document.querySelectorAll(sel).length > 0) return true;
        const bodyText = document.body.innerText || '';
        if (/no flights found|no results|no flight available|showing\s*\(0\)/i.test(bodyText)) return true;
        return false;
      }, FLIGHT_RESULT_SELECTOR, { timeout: 60000 });
    } catch { /* soft timeout */ }

    await page.waitForTimeout(2000);

    // Screenshot + evaluate
    const screenshot = await screenshotter.takeStep(page, runId, stepName);
    if (screenshot) {
      result.evaluation = await evaluateStep(screenshot, stepName, scenario);
    }

    result.status = 'completed';
    logger.info('[FLIGHT-SEARCH] Step complete');
  } catch (err) {
    logger.error(`[FLIGHT-SEARCH] Failed: ${err.message}`);
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
