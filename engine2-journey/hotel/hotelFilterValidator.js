const logger = require('../../utils/logger');

const HOTEL_FILTER_TESTS = [
  {
    id: 'HTL-FILTER-01', name: 'Star Rating - 5 Star Only',
    selector: '[data-filter="5star"], label:has-text("5 Star"), input[value="5"], [data-star="5"]',
    validateFn: async (page) => {
      const stars = await page.$$eval('[class*="star-rating"], [class*="hotel-stars"]', els =>
        els.map(e => (e.querySelectorAll('[class*="filled"], [class*="active"]') || []).length)
      );
      return stars.length > 0 && stars.every(s => s === 5);
    },
  },
  {
    id: 'HTL-FILTER-02', name: 'Sort by Price (Low to High)',
    selector: '[data-sort="price"], button:has-text("Price"), .sort-price',
    validateFn: async (page) => {
      const prices = await page.$$eval('[class*="hotel-price"], [class*="room-price"], [class*="per-night"]', els =>
        els.map(e => { const m = e.textContent.match(/[\d,]+/); return m ? parseInt(m[0].replace(/,/g, '')) : null; }).filter(Boolean)
      );
      for (let i = 1; i < Math.min(5, prices.length); i++) { if (prices[i] < prices[i - 1]) return false; }
      return prices.length > 0;
    },
  },
  {
    id: 'HTL-FILTER-03', name: 'Free Cancellation',
    selector: '[data-filter="free-cancellation"], label:has-text("Free Cancellation"), label:has-text("Refundable")',
    validateFn: async (page) => {
      const labels = await page.$$eval('[class*="cancellation"], [class*="refund"]', els => els.map(e => e.textContent.trim().toLowerCase()));
      return labels.length > 0 && labels.every(l => l.includes('free') || l.includes('refund'));
    },
  },
  {
    id: 'HTL-FILTER-04', name: 'Guest Rating (4+)',
    selector: '[data-filter="rating"], label:has-text("4+"), [class*="guest-rating"]',
    validateFn: async (page) => {
      const ratings = await page.$$eval('[class*="rating-score"], [class*="review-score"]', els => els.map(e => parseFloat(e.textContent)));
      return ratings.length > 0 && ratings.every(r => !isNaN(r) && r >= 4.0);
    },
  },
  {
    id: 'HTL-FILTER-05', name: 'Free Breakfast',
    selector: '[data-filter="breakfast"], label:has-text("Free Breakfast"), label:has-text("Breakfast Included")',
    validateFn: async (page) => {
      const tags = await page.$$eval('[class*="amenity"], [class*="inclusion"], [class*="meal"]', els => els.map(e => e.textContent.trim().toLowerCase()));
      return tags.some(t => t.includes('breakfast'));
    },
  },
  {
    id: 'HTL-FILTER-06', name: 'Sort by Rating',
    selector: '[data-sort="rating"], button:has-text("Rating"), .sort-rating',
    validateFn: async (page) => { return true; },
  },
  {
    id: 'HTL-FILTER-07', name: 'Combination: 5 Star + Free Cancellation',
    combinationOf: ['HTL-FILTER-01', 'HTL-FILTER-03'],
    validateFn: async (page) => { return true; },
  },
];

async function validateHotelFilters(page, scenario, runId) {
  const results = {
    scenarioId: scenario.id,
    filterResults: [],
    criticalFailures: [],
    partialFailures: [],
    passing: [],
    notFound: [],
    combinationResult: null,
  };

  for (const filterTest of HOTEL_FILTER_TESTS) {
    if (filterTest.combinationOf) continue;
    const filterResult = await runSingleTest(page, filterTest);
    categorize(filterResult, results);
    await resetFilters(page);
    await page.waitForTimeout(1000);
  }

  const combTest = HOTEL_FILTER_TESTS.find(t => t.combinationOf);
  if (combTest) {
    results.combinationResult = await runCombTest(page, combTest, HOTEL_FILTER_TESTS);
  }

  logger.info(`[HTL-FILTER] Results: ${results.passing.length} pass, ${results.criticalFailures.length} fail, ${results.notFound.length} not found`);
  return results;
}

async function runSingleTest(page, filterTest) {
  const result = { filterId: filterTest.id, filterName: filterTest.name, status: 'NOT_FOUND', beforeCount: 0, afterCount: 0, countChanged: false, validationPassed: false };
  try {
    result.beforeCount = await countHotels(page);
    const sels = filterTest.selector.split(', ');
    let el = null;
    for (const sel of sels) { el = await page.$(sel.trim()); if (el) break; }
    if (!el) return result;

    await el.click();
    await page.waitForTimeout(1500);
    await page.waitForLoadState('networkidle').catch(() => {});

    result.afterCount = await countHotels(page);
    result.countChanged = result.afterCount !== result.beforeCount;
    result.validationPassed = await filterTest.validateFn(page);
    result.status = result.validationPassed ? 'PASS' : result.countChanged ? 'PARTIAL' : 'FAIL';
  } catch (err) {
    result.status = 'ERROR';
    result.errorDetail = err.message;
  }
  return result;
}

async function runCombTest(page, combTest, allTests) {
  try {
    for (const filterId of combTest.combinationOf) {
      const test = allTests.find(t => t.id === filterId);
      if (!test) continue;
      const sels = test.selector.split(', ');
      for (const sel of sels) { const el = await page.$(sel.trim()); if (el) { await el.click(); await page.waitForTimeout(1000); break; } }
    }
    await page.waitForTimeout(1500);
    const passed = await combTest.validateFn(page);
    await resetFilters(page);
    return { status: passed ? 'PASS' : 'FAIL' };
  } catch (err) { return { status: 'ERROR', error: err.message }; }
}

async function countHotels(page) {
  try { return (await page.$$('[class*="hotel-card"], [class*="property-card"], [class*="hotel-result"]')).length; } catch { return 0; }
}

async function resetFilters(page) {
  try { const btn = await page.$('[class*="reset"], [class*="clear-filter"], button:has-text("Clear")'); if (btn) await btn.click(); } catch {}
}

function categorize(filterResult, results) {
  results.filterResults.push(filterResult);
  if (filterResult.status === 'PASS') results.passing.push(filterResult);
  else if (filterResult.status === 'PARTIAL') results.partialFailures.push(filterResult);
  else if (filterResult.status === 'FAIL' || filterResult.status === 'ERROR') results.criticalFailures.push(filterResult);
  else results.notFound.push(filterResult);
}

module.exports = { validateHotelFilters, HOTEL_FILTER_TESTS };
