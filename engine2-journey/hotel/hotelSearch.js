const logger = require('../../utils/logger');
const screenshotter = require('../../utils/screenshotter');
const { evaluateStep } = require('../evaluator/visionEval');
const {
  fillAutosuggest, pickHotelDateRange, clickSearchHotels,
} = require('../../utils/etravFormHelpers');

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

async function execute(page, scenario, runId) {
  const stepName = 'hotelSearch';
  const result = { stepName, timestamp: new Date().toISOString(), actions: [] };

  try {
    logger.info(`[HOTEL-SEARCH] Starting — ${scenario.label}`);

    // Navigate to hotels page directly - updated timeout handling
    await page.goto('https://new.etrav.in/hotels', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1500);

    // Dismiss any lingering modal
    await page.evaluate(() => {
      ['.react-responsive-modal-root', '.react-responsive-modal-container', '.react-responsive-modal-overlay']
        .forEach(sel => document.querySelectorAll(sel).forEach(el => el.remove()));
    });

    // Fill destination (react-autosuggest)
    let destOk = await fillAutosuggest(page, 'Hotel name or Destination', scenario.destination);
    if (!destOk) destOk = await fillAutosuggest(page, 'City or Hotel', scenario.destination);
    if (!destOk) destOk = await fillAutosuggest(page, 'Where to ?', scenario.destination);
    result.actions.push(`Destination: ${scenario.destination} [${destOk ? 'OK' : 'FAIL'}]`);

    // Pick check-in and check-out via the hotel range picker
    const checkinDate = addDays(new Date(), scenario.checkinOffsetDays || 10);
    const checkoutDate = addDays(checkinDate, scenario.nights || 3);
    const rangeOk = await pickHotelDateRange(page, checkinDate, checkoutDate);
    result.actions.push(`Check-in: ${checkinDate.toDateString()}, Check-out: ${checkoutDate.toDateString()} [${rangeOk ? 'OK' : 'FAIL'}]`);

    await page.waitForTimeout(500);

    // Click search
    const searchClicked = await clickSearchHotels(page);
    result.actions.push(`Search clicked: ${searchClicked}`);

    logger.info('[HOTEL-SEARCH] Waiting for results...');

    // Wait for real hotel cards
    try {
      await page.waitForFunction(() => {
        const cards = document.querySelectorAll(
          '.hotel_card, .hotel-card, [class*="hotel_card"]:not([class*="skeleton"]), ' +
          '[class*="property_card"], [class*="HotelCard"]'
        );
        if (cards.length > 0) return true;
        const bodyText = document.body.innerText || '';
        if (/no hotels found|no results|no hotel available|showing\s*\(0\)/i.test(bodyText)) return true;
        return false;
      }, { timeout: 60000 });
    } catch { /* soft timeout */ }

    await page.waitForTimeout(2000);

    // Screenshot + evaluate
    const screenshot = await screenshotter.takeStep(page, runId, stepName);
    if (screenshot) {
      result.evaluation = await evaluateStep(screenshot, stepName, scenario);
    }

    result.status = 'completed';
    logger.info('[HOTEL-SEARCH] Step complete');
  } catch (err) {
    logger.error(`[HOTEL-SEARCH] Failed: ${err.message}`);
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