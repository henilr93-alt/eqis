const logger = require('../../utils/logger');
const screenshotter = require('../../utils/screenshotter');
const { evaluateStep } = require('../evaluator/visionEval');
const { generatePassengerSet } = require('../../fakeData/generator');

async function fillPassenger(page, passenger, index) {
  const prefix = `pax-${index}`;

  // Title
  const titleSelectors = [
    `select[name*="title"]:nth-of-type(${index + 1})`,
    `.passenger-${index + 1} select[name*="title"]`,
    `[data-pax="${index}"] select`,
    `select[name*="Title"]`,
  ];
  for (const sel of titleSelectors) {
    const el = await page.$(sel);
    if (el) {
      await el.selectOption({ label: passenger.title });
      break;
    }
  }

  // First name
  const fnSelectors = [
    `input[name*="firstName"][data-pax="${index}"]`,
    `.passenger-${index + 1} input[name*="first"]`,
    `input[name*="FirstName"]:nth-of-type(${index + 1})`,
    `input[placeholder*="First Name"]:nth-of-type(${index + 1})`,
  ];
  for (const sel of fnSelectors) {
    const el = await page.$(sel);
    if (el) {
      await el.fill(passenger.firstName);
      break;
    }
  }

  // Last name
  const lnSelectors = [
    `input[name*="lastName"][data-pax="${index}"]`,
    `.passenger-${index + 1} input[name*="last"]`,
    `input[name*="LastName"]:nth-of-type(${index + 1})`,
    `input[placeholder*="Last Name"]:nth-of-type(${index + 1})`,
  ];
  for (const sel of lnSelectors) {
    const el = await page.$(sel);
    if (el) {
      await el.fill(passenger.lastName);
      break;
    }
  }

  // Date of birth
  const dobSelectors = [
    `input[name*="dob"][data-pax="${index}"]`,
    `.passenger-${index + 1} input[name*="dob"]`,
    `input[name*="dateOfBirth"]:nth-of-type(${index + 1})`,
    `input[placeholder*="DOB"]:nth-of-type(${index + 1})`,
  ];
  for (const sel of dobSelectors) {
    const el = await page.$(sel);
    if (el) {
      await el.fill(passenger.dob);
      break;
    }
  }

  // Passport (for international)
  if (passenger.passportNumber) {
    const ppSelectors = [
      `input[name*="passport"][data-pax="${index}"]`,
      `.passenger-${index + 1} input[name*="passport"]`,
      `input[placeholder*="Passport"]:nth-of-type(${index + 1})`,
    ];
    for (const sel of ppSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.fill(passenger.passportNumber);
        break;
      }
    }
  }

  logger.info(`[PASSENGER] Filled ${passenger.type}: ${passenger.title} ${passenger.firstName} ${passenger.lastName}`);
}

async function execute(page, scenario, runId) {
  const stepName = 'passengerForm';
  const result = { stepName, timestamp: new Date().toISOString(), actions: [] };

  try {
    logger.info('[PASSENGER-FORM] Filling passenger details...');
    await page.waitForTimeout(2000);

    const passengers = generatePassengerSet(scenario);
    result.actions.push(`Generated ${passengers.length} passengers`);

    // Fill each passenger
    for (let i = 0; i < passengers.length; i++) {
      await fillPassenger(page, passengers[i], i);
      await page.waitForTimeout(500);
    }

    // Fill contact details from first adult
    const firstAdult = passengers.find((p) => p.type === 'adult');
    if (firstAdult) {
      // Phone
      const phoneSelectors = [
        'input[name*="phone"]', 'input[name*="mobile"]',
        'input[type="tel"]', 'input[placeholder*="Phone"]',
        'input[placeholder*="Mobile"]',
      ];
      for (const sel of phoneSelectors) {
        const el = await page.$(sel);
        if (el) {
          await el.fill(firstAdult.phone);
          result.actions.push(`Phone: ${firstAdult.phone}`);
          break;
        }
      }

      // Email
      const emailSelectors = [
        'input[name*="email"]', 'input[type="email"]',
        'input[placeholder*="Email"]',
      ];
      for (const sel of emailSelectors) {
        const el = await page.$(sel);
        if (el) {
          await el.fill(firstAdult.email);
          result.actions.push(`Email: ${firstAdult.email}`);
          break;
        }
      }
    }

    await page.waitForTimeout(1000);

    // Click continue/submit
    const continueSelectors = [
      'button:has-text("Continue")',
      'button:has-text("Proceed")',
      'button:has-text("Next")',
      'button:has-text("Review")',
      'button[type="submit"]',
      '.continue-btn',
    ];

    for (const sel of continueSelectors) {
      const el = await page.$(sel);
      if (el) {
        // Screenshot before clicking continue
        await screenshotter.takeStep(page, runId, 'passengerFormFilled');
        await el.click();
        result.actions.push('Clicked continue');
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
    result.passengerCount = passengers.length;
    logger.info('[PASSENGER-FORM] Step complete');
  } catch (err) {
    logger.error(`[PASSENGER-FORM] Failed: ${err.message}`);
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
