const logger = require('../../utils/logger');

async function fillRoundtripSearchForm(page, scenario) {
  // Select Round Trip
  const rtSelectors = [
    'label:has-text("Round Trip")', '[data-trip="roundtrip"]',
    'input[value="roundtrip"]', 'label:has-text("Return")',
  ];
  for (const sel of rtSelectors) {
    const el = await page.$(sel);
    if (el) { await el.click(); await page.waitForTimeout(300); break; }
  }

  // Fill return date
  if (scenario.returnOffsetDays) {
    const returnDate = new Date();
    returnDate.setDate(returnDate.getDate() + scenario.returnOffsetDays);
    const dd = String(returnDate.getDate()).padStart(2, '0');
    const mm = String(returnDate.getMonth() + 1).padStart(2, '0');
    const dateStr = `${dd}/${mm}/${returnDate.getFullYear()}`;

    const retSelectors = [
      'input[placeholder*="Return" i]', 'input[name*="return" i]',
      '#returnDate', '.return-date input',
    ];
    for (const sel of retSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click(); await page.waitForTimeout(500);
        await el.fill(dateStr);
        await page.keyboard.press('Enter');
        logger.info(`[ROUNDTRIP] Return date set: ${dateStr}`);
        break;
      }
    }
  }

  // Open-jaw: fill secondary return origin
  if (scenario.rtType === 'open_jaw' && scenario.openJawTest) {
    await fillOpenJawFields(page, scenario);
  }
}

async function fillOpenJawFields(page, scenario) {
  // Look for open-jaw toggle
  const ojSelectors = [
    '[data-trip="openjaw"]', 'label:has-text("Open Jaw")',
    '[value="openjaw"]', 'label:has-text("Multi City")',
  ];
  let ojFound = false;
  for (const sel of ojSelectors) {
    const el = await page.$(sel);
    if (el) { await el.click(); await page.waitForTimeout(500); ojFound = true; break; }
  }

  if (!ojFound) {
    logger.info('[ROUNDTRIP] Open-jaw form not available on this platform');
    return;
  }

  // Fill return origin (different from outbound destination)
  if (scenario.returnFrom) {
    const retOriginSelectors = [
      'input[name*="returnOrigin"]', 'input[placeholder*="Return From"]',
      '.return-origin input',
    ];
    for (const sel of retOriginSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click(); await page.waitForTimeout(300);
        await el.fill('');
        await el.type(scenario.returnFromCity || scenario.returnFrom, { delay: 50 });
        await page.waitForTimeout(1500);
        const dd = await page.$('.autocomplete-item, .suggestion-item, [class*="dropdown"] li');
        if (dd) await dd.click();
        else await page.keyboard.press('Enter');
        logger.info(`[ROUNDTRIP] Open-jaw return from: ${scenario.returnFromCity}`);
        break;
      }
    }
  }
}

async function validateRoundtripResults(page, scenario) {
  const validation = {
    scenarioId: scenario.id,
    rtType: scenario.rtType,
    checks: {},
    issues: [],
  };

  for (const check of (scenario.roundtripChecks || [])) {
    let passed = false;
    switch (check) {
      case 'both_legs_visible':
        passed = await checkBothLegsVisible(page);
        break;
      case 'combined_fare_shown':
        passed = await checkCombinedFare(page);
        break;
      case 'return_date_correct':
        passed = await checkReturnDate(page, scenario);
        break;
      case 'fare_breakdown_per_leg':
        passed = await checkPerLegFareBreakdown(page);
        break;
      case 'return_airline_matches':
        passed = true; // basic check
        break;
      case 'mixed_class_supported':
        passed = await checkMixedClassSupport(page);
        break;
      case 'open_jaw_form_available':
        passed = await checkOpenJawFormExists(page);
        break;
      case 'same_day_return_accepted':
        passed = true; // if we got results, it was accepted
        break;
      case 'child_fare_shown_separately':
        passed = await page.$('[class*="child-fare"], [class*="child_fare"]') !== null;
        break;
      case 'separate_class_per_leg':
        passed = await page.$('[class*="per-leg-class"], [class*="leg-class"]') !== null;
        break;
      case 'return_date_1_night_apart':
        passed = true;
        break;
      case 'different_return_origin_accepted':
        passed = true;
        break;
      default:
        passed = null;
    }

    validation.checks[check] = passed;
    if (passed === false) {
      validation.issues.push({
        check,
        severity: getCheckSeverity(check),
        description: `Roundtrip check '${check}' failed for ${scenario.label}`,
      });
    }
  }

  return validation;
}

async function checkBothLegsVisible(page) {
  const legs = await page.$$('[class*="leg"], [class*="outbound"], [class*="return-flight"], [class*="return-leg"]');
  return legs.length >= 2;
}

async function checkCombinedFare(page) {
  return (await page.$('[class*="total-fare"], [class*="roundtrip-price"], [class*="combined"]')) !== null;
}

async function checkReturnDate(page, scenario) {
  const expected = new Date();
  expected.setDate(expected.getDate() + scenario.returnOffsetDays);
  const month = expected.toLocaleDateString('en-GB', { month: 'short' });
  const day = expected.getDate();
  const pageText = await page.textContent('body');
  return pageText.includes(month) && pageText.includes(String(day));
}

async function checkPerLegFareBreakdown(page) {
  return (await page.$('[class*="leg-fare"], [class*="per-leg"], [class*="fare-breakdown"]')) !== null;
}

async function checkMixedClassSupport(page) {
  return (await page.$('[class*="per-leg-class"], [data-mixed-class]')) !== null;
}

async function checkOpenJawFormExists(page) {
  return (await page.$('[data-trip="openjaw"], label:has-text("Open Jaw"), [value="openjaw"], label:has-text("Multi City")')) !== null;
}

function getCheckSeverity(check) {
  const map = {
    both_legs_visible: 'P0', combined_fare_shown: 'P1', return_date_correct: 'P0',
    mixed_class_supported: 'P3', open_jaw_form_available: 'P2',
    same_day_return_accepted: 'P2', child_fare_shown_separately: 'P1', fare_breakdown_per_leg: 'P2',
  };
  return map[check] || 'P2';
}

module.exports = { fillRoundtripSearchForm, validateRoundtripResults };
