const logger = require('../../utils/logger');
const screenshotter = require('../../utils/screenshotter');
const { evaluateStep } = require('../evaluator/visionEval');

async function execute(page, scenario, runId) {
  const stepName = 'hotelRoomSelect';
  const result = { stepName, timestamp: new Date().toISOString(), actions: [] };

  try {
    logger.info(`[HOTEL-ROOM] Looking for room type: ${scenario.preferRoomType}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // Try to find preferred room type
    let roomFound = false;
    const preferredSelectors = [
      `text=${scenario.preferRoomType}`,
      `.room-card:has-text("${scenario.preferRoomType}")`,
      `[class*="room"]:has-text("${scenario.preferRoomType}")`,
    ];

    for (const sel of preferredSelectors) {
      const el = await page.$(sel);
      if (el) {
        // Find the select/book button near this room
        const parent = await el.$('xpath=ancestor::div[contains(@class, "room")]');
        if (parent) {
          const btn = await parent.$('button');
          if (btn) {
            await btn.click();
            roomFound = true;
            result.actions.push(`Selected preferred room: ${scenario.preferRoomType}`);
            break;
          }
        }
        // Fallback: click the element directly
        await el.click();
        roomFound = true;
        result.actions.push(`Clicked preferred room: ${scenario.preferRoomType}`);
        break;
      }
    }

    // If preferred not found, select first available room
    if (!roomFound) {
      const firstRoomSelectors = [
        '.room-card:first-child button:has-text("Select")',
        '.room-card:first-child button:has-text("Book")',
        '.room-option:first-child button',
        '.room-type:first-child .select-btn',
        'button:has-text("Select Room"):first-of-type',
        'button:has-text("Book Now"):first-of-type',
      ];

      for (const sel of firstRoomSelectors) {
        const el = await page.$(sel);
        if (el) {
          await el.click();
          result.actions.push('Selected first available room (preferred not found)');
          logger.info('[HOTEL-ROOM] Preferred room not found, selected first available');
          break;
        }
      }
    }

    await page.waitForTimeout(1500);

    // Handle any popup/modal that appears after room selection
    const modalCloseSelectors = [
      '.modal .close', '.modal-close', '[class*="modal"] .close-btn',
      'button[aria-label="Close"]',
    ];

    for (const sel of modalCloseSelectors) {
      const el = await page.$(sel);
      if (el) {
        // Don't close — this might be the room detail modal. Screenshot first.
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

    // Try to proceed to booking/guest details
    const proceedSelectors = [
      'button:has-text("Book Now")',
      'button:has-text("Continue")',
      'button:has-text("Proceed")',
      'button:has-text("Reserve")',
      '.book-btn',
      '.proceed-btn',
    ];

    for (const sel of proceedSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        result.actions.push('Clicked proceed to booking');
        break;
      }
    }

    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    result.status = 'completed';
    logger.info('[HOTEL-ROOM] Step complete');
  } catch (err) {
    logger.error(`[HOTEL-ROOM] Failed: ${err.message}`);
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
