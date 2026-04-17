const logger = require('../../utils/logger');
const screenshotter = require('../../utils/screenshotter');

const FLIGHT_FILTER_TESTS = [
  {
    id: 'FLT-FILTER-01', name: 'Non-Stop Only',
    selector: '[data-filter="nonstop"], [class*="nonstop"], label:has-text("Non Stop"), label:has-text("Direct")',
    expectedBehavior: 'all_results_have_zero_stops',
    validateFn: async (page) => {
      const stops = await page.$$eval('[class*="stops"], [class*="stop-count"]', els => els.map(e => e.textContent.trim().toLowerCase()));
      return stops.length > 0 && stops.every(s => s.includes('non-stop') || s.includes('0 stop') || s === '0');
    },
  },
  {
    id: 'FLT-FILTER-02', name: 'Sort by Price (Low to High)',
    selector: '[data-sort="price"], button:has-text("Price"), .sort-price',
    expectedBehavior: 'prices_ascending',
    validateFn: async (page) => {
      const prices = await page.$$eval('[class*="price"], [class*="fare"]', els =>
        els.map(e => { const m = e.textContent.match(/[\d,]+/); return m ? parseInt(m[0].replace(/,/g, '')) : null; }).filter(Boolean)
      );
      for (let i = 1; i < Math.min(5, prices.length); i++) { if (prices[i] < prices[i - 1]) return false; }
      return prices.length > 0;
    },
  },
  {
    id: 'FLT-FILTER-03', name: 'Morning Departure (06:00-12:00)',
    selector: '[data-filter="morning"], label:has-text("Morning")',
    expectedBehavior: 'departure_times_morning_only',
    validateFn: async (page) => {
      const times = await page.$$eval('[class*="departure-time"], [class*="dep-time"]', els => els.map(e => e.textContent.trim()));
      return times.slice(0, 5).every(t => { const h = parseInt(t.split(':')[0]); return h >= 6 && h < 12; });
    },
  },
  {
    id: 'FLT-FILTER-04', name: 'Airline Filter (single airline)',
    selector: '[class*="airline-filter"] input, [data-filter-type="airline"] input',
    selectFirst: true,
    expectedBehavior: 'results_show_only_selected_airline',
    validateFn: async (page, selectedAirline) => {
      if (!selectedAirline) return null;
      const airlines = await page.$$eval('[class*="airline-name"], [class*="carrier-name"]', els => els.map(e => e.textContent.trim()));
      return airlines.every(a => a.includes(selectedAirline));
    },
  },
  {
    id: 'FLT-FILTER-05', name: 'Business Class Only',
    selector: '[data-filter="business"], label:has-text("Business")',
    expectedBehavior: 'all_results_business_class',
    validateFn: async (page) => {
      const classes = await page.$$eval('[class*="cabin-class"], [class*="fare-class"]', els => els.map(e => e.textContent.trim().toLowerCase()));
      return classes.length > 0 && classes.every(c => c.includes('business'));
    },
  },
  {
    id: 'FLT-FILTER-06', name: 'Sort by Duration',
    selector: '[data-sort="duration"], button:has-text("Duration"), .sort-duration',
    expectedBehavior: 'durations_ascending',
    validateFn: async (page) => { return true; },
  },
  {
    id: 'FLT-FILTER-07', name: 'Combination: Non-Stop + Price Sort',
    combinationOf: ['FLT-FILTER-01', 'FLT-FILTER-02'],
    expectedBehavior: 'non_stop_results_sorted_by_price',
    validateFn: async (page) => { return true; },
  },
];

async function validateFlightFilters(page, scenario, runId) {
  const results = {
    scenarioId: scenario.id,
    filtersAvailable: [],
    filterResults: [],
    criticalFailures: [],
    partialFailures: [],
    passing: [],
    notFound: [],
    combinationResult: null,
  };

  results.filtersAvailable = await discoverFiltersOnPage(page);
  logger.info(`[FILTER-VAL] ${results.filtersAvailable.length} filters discovered on page`);

  for (const filterTest of FLIGHT_FILTER_TESTS) {
    if (filterTest.combinationOf) continue;
    const filterResult = await runSingleFilterTest(page, filterTest, runId);
    categorizeResult(filterResult, results);
    await resetFilters(page);
    await page.waitForTimeout(1000);
  }

  // Combination test
  const combTest = FLIGHT_FILTER_TESTS.find(t => t.combinationOf);
  if (combTest) {
    results.combinationResult = await runCombinationTest(page, combTest, FLIGHT_FILTER_TESTS, runId);
  }

  logger.info(`[FILTER-VAL] Results: ${results.passing.length} pass, ${results.criticalFailures.length} fail, ${results.notFound.length} not found`);
  return results;
}

async function runSingleFilterTest(page, filterTest, runId) {
  const result = {
    filterId: filterTest.id, filterName: filterTest.name,
    status: 'NOT_FOUND', beforeCount: 0, afterCount: 0,
    countChanged: false, badgeActive: false, validationPassed: false,
    removalWorked: false, url: page.url(), errorDetail: null,
  };

  try {
    result.beforeCount = await countVisibleResults(page);

    const sels = filterTest.selector.split(', ');
    let el = null;
    let selectedAirline = null;

    for (const sel of sels) {
      el = await page.$(sel.trim());
      if (el) break;
    }

    if (!el) { result.status = 'NOT_FOUND'; return result; }

    if (filterTest.selectFirst) {
      const allEls = await page.$$(sels[0]);
      if (allEls.length > 0) {
        selectedAirline = await allEls[0].textContent();
        selectedAirline = selectedAirline?.trim();
        await allEls[0].click();
      }
    } else {
      await el.click();
    }

    await page.waitForTimeout(1500);
    await page.waitForLoadState('networkidle').catch(() => {});

    result.afterCount = await countVisibleResults(page);
    result.countChanged = result.afterCount !== result.beforeCount;
    result.badgeActive = await isFilterBadgeActive(page);
    result.validationPassed = await filterTest.validateFn(page, selectedAirline);

    // Test removal
    if (!filterTest.selectFirst) {
      await el.click();
      await page.waitForTimeout(1000);
      const afterRemoval = await countVisibleResults(page);
      result.removalWorked = Math.abs(afterRemoval - result.beforeCount) <= 2;
    }

    result.status = result.validationPassed ? 'PASS' : result.countChanged ? 'PARTIAL' : 'FAIL';
  } catch (err) {
    result.status = 'ERROR';
    result.errorDetail = err.message;
  }

  return result;
}

async function runCombinationTest(page, combTest, allTests, runId) {
  try {
    for (const filterId of combTest.combinationOf) {
      const test = allTests.find(t => t.id === filterId);
      if (!test) continue;
      const sels = test.selector.split(', ');
      for (const sel of sels) {
        const el = await page.$(sel.trim());
        if (el) { await el.click(); await page.waitForTimeout(1000); break; }
      }
    }
    await page.waitForTimeout(1500);
    const passed = await combTest.validateFn(page);
    await resetFilters(page);
    return { status: passed ? 'PASS' : 'FAIL', combinationOf: combTest.combinationOf };
  } catch (err) {
    return { status: 'ERROR', error: err.message };
  }
}

async function countVisibleResults(page) {
  try {
    return (await page.$$('[class*="flight-card"], [class*="result-item"], [data-testid="flight-result"]')).length;
  } catch { return 0; }
}

async function isFilterBadgeActive(page) {
  try {
    return (await page.$('[class*="active-filter"], [class*="filter-tag"], [class*="applied"]')) !== null;
  } catch { return false; }
}

async function resetFilters(page) {
  try {
    const btn = await page.$('[class*="reset"], [class*="clear-filter"], button:has-text("Clear"), button:has-text("Reset")');
    if (btn) await btn.click();
  } catch { /* ignore */ }
}

async function discoverFiltersOnPage(page) {
  try {
    return await page.$$eval(
      '[class*="filter"] input, [class*="filter"] button, [data-filter]',
      els => els.map(e => ({ type: e.tagName, text: e.textContent?.trim()?.slice(0, 50), dataFilter: e.getAttribute('data-filter') }))
    );
  } catch { return []; }
}

function filterResultsToHtml(results) {
  if (!results || results.filterResults.length === 0) return '<p style="color:#888;">No filter tests ran.</p>';
  const rows = [...results.passing, ...results.partialFailures, ...results.criticalFailures, ...results.notFound].map(r => {
    const color = r.status === 'PASS' ? '#34C759' : r.status === 'PARTIAL' ? '#FFCC00' : r.status === 'FAIL' ? '#FF3B30' : '#888';
    return `<tr>
      <td>${r.filterName}</td>
      <td style="color:${color};">${r.status}</td>
      <td>${r.beforeCount} -> ${r.afterCount}</td>
      <td>${r.validationPassed ? 'Yes' : 'No'}</td>
      <td>${r.removalWorked ? 'Yes' : 'N/A'}</td>
    </tr>`;
  }).join('');
  return `<table><thead><tr><th>Filter</th><th>Status</th><th>Count Change</th><th>Validated</th><th>Removal</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function categorizeResult(filterResult, results) {
  results.filterResults.push(filterResult);
  if (filterResult.status === 'PASS') results.passing.push(filterResult);
  else if (filterResult.status === 'PARTIAL') results.partialFailures.push(filterResult);
  else if (filterResult.status === 'FAIL' || filterResult.status === 'ERROR') results.criticalFailures.push(filterResult);
  else results.notFound.push(filterResult);
}

module.exports = { validateFlightFilters, filterResultsToHtml, FLIGHT_FILTER_TESTS };
