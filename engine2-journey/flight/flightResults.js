const logger = require('../../utils/logger');
const screenshotter = require('../../utils/screenshotter');
const { evaluateStep } = require('../evaluator/visionEval');

const FILTER_ACTIONS = {
  sort_by_price: async (page) => {
    const selectors = [
      'button:has-text("Price")', '[data-sort="price"]',
      'option:has-text("Price")', '.sort-price',
    ];
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el) { await el.click(); return true; }
    }
    return false;
  },

  sort_by_duration: async (page) => {
    const selectors = [
      'button:has-text("Duration")', '[data-sort="duration"]',
      'option:has-text("Duration")', '.sort-duration',
    ];
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el) { await el.click(); return true; }
    }
    return false;
  },

  sort_by_rating: async (page) => {
    const selectors = [
      'button:has-text("Rating")', '[data-sort="rating"]',
    ];
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el) { await el.click(); return true; }
    }
    return false;
  },

  nonstop_only: async (page) => {
    const selectors = [
      'label:has-text("Non Stop")', 'label:has-text("Nonstop")',
      'label:has-text("Direct")', 'input[value="nonstop"]',
      '[data-filter="nonstop"]',
    ];
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el) { await el.click(); return true; }
    }
    return false;
  },

  business_only: async (page) => {
    const selectors = [
      'label:has-text("Business")', '[data-filter="business"]',
    ];
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el) { await el.click(); return true; }
    }
    return false;
  },

  morning_flights: async (page) => {
    const selectors = [
      'label:has-text("Morning")', '[data-filter="morning"]',
      'label:has-text("6 AM")',
    ];
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el) { await el.click(); return true; }
    }
    return false;
  },

  airline_filter: async (page) => {
    // Generic airline filter — click first airline checkbox
    const selectors = [
      '.airline-filter input[type="checkbox"]:first-child',
      '[data-filter-type="airline"] input:first-child',
    ];
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el) { await el.click(); return true; }
    }
    return false;
  },

  airline_filter_indigo: async (page) => {
    const selectors = [
      'label:has-text("IndiGo")', 'label:has-text("6E")',
    ];
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el) { await el.click(); return true; }
    }
    return false;
  },
};

async function execute(page, scenario, runId) {
  const stepName = 'flightResults';
  const result = { stepName, timestamp: new Date().toISOString(), actions: [], filterResults: [] };

  try {
    logger.info('[FLIGHT-RESULTS] Applying filters...');

    // Apply each filter
    for (const filterName of scenario.filtersToApply) {
      const action = FILTER_ACTIONS[filterName];
      if (action) {
        const applied = await action(page);
        result.filterResults.push({ filter: filterName, applied });
        if (applied) {
          await page.waitForTimeout(1500);
          logger.info(`[FLIGHT-RESULTS] Filter applied: ${filterName}`);
        } else {
          logger.warn(`[FLIGHT-RESULTS] Filter not found: ${filterName}`);
        }
      }
    }

    // Screenshot after filters
    const filterScreenshot = await screenshotter.takeStep(page, runId, 'flightFilters');
    if (filterScreenshot) {
      result.filterEvaluation = await evaluateStep(filterScreenshot, 'flightFilters', scenario);
    }

    await page.waitForTimeout(1000);

    // Select first flight result
    const resultSelectors = [
      '.flight-card:first-child .book-btn',
      '.flight-result:first-child button',
      '.result-card:first-child .select-btn',
      '.flight-item:first-child button:has-text("Book")',
      '.flight-item:first-child button:has-text("Select")',
      'button:has-text("Book Now"):first-of-type',
      '.fare-btn:first-of-type',
    ];

    let selected = false;
    for (const sel of resultSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        selected = true;
        result.actions.push(`Selected flight: ${sel}`);
        logger.info('[FLIGHT-RESULTS] Flight selected');
        break;
      }
    }

    if (!selected) {
      // Try clicking the first result card itself
      const cardSelectors = [
        '.flight-card:first-child',
        '.flight-result:first-child',
        '.result-card:first-child',
      ];
      for (const sel of cardSelectors) {
        const el = await page.$(sel);
        if (el) {
          await el.click();
          result.actions.push(`Clicked flight card: ${sel}`);
          break;
        }
      }
    }

    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // Screenshot + evaluate
    const screenshot = await screenshotter.takeStep(page, runId, stepName);
    if (screenshot) {
      result.evaluation = await evaluateStep(screenshot, 'flightSelection', scenario);
    }

    result.status = 'completed';
    logger.info('[FLIGHT-RESULTS] Step complete');
  } catch (err) {
    logger.error(`[FLIGHT-RESULTS] Failed: ${err.message}`);
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
