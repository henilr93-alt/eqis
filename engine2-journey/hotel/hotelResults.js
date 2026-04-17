const logger = require('../../utils/logger');
const screenshotter = require('../../utils/screenshotter');
const { evaluateStep } = require('../evaluator/visionEval');

const FILTER_ACTIONS = {
  sort_by_price: async (page) => {
    const selectors = ['button:has-text("Price")', '[data-sort="price"]', '.sort-price'];
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el) { await el.click(); return true; }
    }
    return false;
  },

  sort_by_rating: async (page) => {
    const selectors = ['button:has-text("Rating")', '[data-sort="rating"]', '.sort-rating'];
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el) { await el.click(); return true; }
    }
    return false;
  },

  '5_star': async (page) => {
    const selectors = [
      'label:has-text("5 Star")', 'label:has-text("5★")',
      'input[value="5"]', '[data-star="5"]',
    ];
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el) { await el.click(); return true; }
    }
    return false;
  },

  free_cancellation: async (page) => {
    const selectors = [
      'label:has-text("Free Cancellation")',
      'label:has-text("Refundable")',
      '[data-filter="free_cancel"]',
    ];
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el) { await el.click(); return true; }
    }
    return false;
  },

  free_breakfast: async (page) => {
    const selectors = [
      'label:has-text("Free Breakfast")',
      'label:has-text("Breakfast Included")',
      'label:has-text("Complimentary Breakfast")',
    ];
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el) { await el.click(); return true; }
    }
    return false;
  },
};

async function applyStarFilter(page, starFilter) {
  const selectors = [
    `label:has-text("${starFilter} Star")`,
    `label:has-text("${starFilter}★")`,
    `input[value="${starFilter}"]`,
    `[data-star="${starFilter}"]`,
  ];
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (el) {
      await el.click();
      return true;
    }
  }
  return false;
}

async function execute(page, scenario, runId) {
  const stepName = 'hotelResults';
  const result = { stepName, timestamp: new Date().toISOString(), actions: [], filterResults: [] };

  try {
    logger.info('[HOTEL-RESULTS] Applying filters...');

    // Apply star filter
    if (scenario.starFilter) {
      const applied = await applyStarFilter(page, scenario.starFilter);
      result.filterResults.push({ filter: `${scenario.starFilter}_star`, applied });
      if (applied) {
        await page.waitForTimeout(1500);
        logger.info(`[HOTEL-RESULTS] Star filter applied: ${scenario.starFilter}★`);
      }
    }

    // Apply other filters
    for (const filterName of scenario.filtersToApply) {
      const action = FILTER_ACTIONS[filterName];
      if (action) {
        const applied = await action(page);
        result.filterResults.push({ filter: filterName, applied });
        if (applied) {
          await page.waitForTimeout(1500);
          logger.info(`[HOTEL-RESULTS] Filter applied: ${filterName}`);
        } else {
          logger.warn(`[HOTEL-RESULTS] Filter not found: ${filterName}`);
        }
      }
    }

    // Screenshot after filters
    await screenshotter.takeStep(page, runId, 'hotelFilters');
    await page.waitForTimeout(1000);

    // Select first hotel
    const hotelSelectors = [
      '.hotel-card:first-child .select-btn',
      '.hotel-card:first-child button:has-text("Select")',
      '.hotel-card:first-child button:has-text("View")',
      '.hotel-result:first-child button',
      '.property-card:first-child button',
      '.hotel-item:first-child a',
    ];

    let selected = false;
    for (const sel of hotelSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        selected = true;
        result.actions.push(`Selected hotel: ${sel}`);
        logger.info('[HOTEL-RESULTS] Hotel selected');
        break;
      }
    }

    if (!selected) {
      const cardSelectors = [
        '.hotel-card:first-child',
        '.hotel-result:first-child',
        '.property-card:first-child',
      ];
      for (const sel of cardSelectors) {
        const el = await page.$(sel);
        if (el) {
          await el.click();
          result.actions.push(`Clicked hotel card: ${sel}`);
          break;
        }
      }
    }

    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // Screenshot + evaluate
    const screenshot = await screenshotter.takeStep(page, runId, stepName);
    if (screenshot) {
      result.evaluation = await evaluateStep(screenshot, 'hotelResults', scenario);
    }

    result.status = 'completed';
    logger.info('[HOTEL-RESULTS] Step complete');
  } catch (err) {
    logger.error(`[HOTEL-RESULTS] Failed: ${err.message}`);
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
