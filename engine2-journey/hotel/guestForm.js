const logger = require('../../utils/logger');
const screenshotter = require('../../utils/screenshotter');
const { evaluateStep } = require('../evaluator/visionEval');
const { generateAdult } = require('../../fakeData/generator');

async function execute(page, scenario, runId) {
  const stepName = 'guestForm';
  const result = { stepName, timestamp: new Date().toISOString(), actions: [] };

  try {
    logger.info('[GUEST-FORM] Filling guest details...');
    await page.waitForTimeout(2000);

    const guest = generateAdult();
    result.actions.push(`Generated guest: ${guest.title} ${guest.firstName} ${guest.lastName}`);

    // Title
    const titleSelectors = [
      'select[name*="title"]', '.guest-title select', '#guestTitle',
    ];
    for (const sel of titleSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.selectOption({ label: guest.title });
        break;
      }
    }

    // First name
    const fnSelectors = [
      'input[name*="firstName" i]', 'input[name*="first_name" i]',
      'input[placeholder*="First Name" i]', '#guestFirstName',
    ];
    for (const sel of fnSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.fill(guest.firstName);
        break;
      }
    }

    // Last name
    const lnSelectors = [
      'input[name*="lastName" i]', 'input[name*="last_name" i]',
      'input[placeholder*="Last Name" i]', '#guestLastName',
    ];
    for (const sel of lnSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.fill(guest.lastName);
        break;
      }
    }

    // Phone
    const phoneSelectors = [
      'input[name*="phone" i]', 'input[name*="mobile" i]',
      'input[type="tel"]', 'input[placeholder*="Phone" i]',
    ];
    for (const sel of phoneSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.fill(guest.phone);
        break;
      }
    }

    // Email
    const emailSelectors = [
      'input[name*="email" i]', 'input[type="email"]',
      'input[placeholder*="Email" i]',
    ];
    for (const sel of emailSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.fill(guest.email);
        break;
      }
    }

    // GST (B2B specific)
    const gstSelectors = [
      'input[name*="gst" i]', 'input[name*="GST"]',
      'input[placeholder*="GST" i]', '#gstNumber',
    ];
    for (const sel of gstSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.fill('22AAAAA0000A1Z5'); // sample GST
        result.actions.push('Filled GST number');
        break;
      }
    }

    await page.waitForTimeout(1000);

    // Screenshot filled form
    const screenshot = await screenshotter.takeStep(page, runId, stepName);
    if (screenshot) {
      result.evaluation = await evaluateStep(screenshot, stepName, scenario);
    }

    // Click continue/proceed
    const continueSelectors = [
      'button:has-text("Continue")',
      'button:has-text("Proceed")',
      'button:has-text("Review")',
      'button:has-text("Next")',
      'button[type="submit"]',
      '.continue-btn',
    ];

    for (const sel of continueSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        result.actions.push('Clicked continue');
        break;
      }
    }

    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    result.status = 'completed';
    logger.info('[GUEST-FORM] Step complete');
  } catch (err) {
    logger.error(`[GUEST-FORM] Failed: ${err.message}`);
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
