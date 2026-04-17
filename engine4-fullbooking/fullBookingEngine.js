const fs = require('fs');
const path = require('path');
const settings = require('../config/settings');
const logger = require('../utils/logger');
const browserModule = require('../engine2-journey/browser');
const login = require('../engine2-journey/login');
const bookingSubmitter = require('./bookingSubmitter');
const pnrCapture = require('./pnrCapture');
const bookingCanceller = require('./bookingCanceller');
const bookingValidator = require('./bookingValidator');
const { UrlTracker } = require('../utils/urlTracker');
const { generateTestPassenger } = require('../fakeData/generator');
const { FLIGHT_SCENARIOS } = require('../scenarios/flightScenarios');
const { HOTEL_SCENARIOS } = require('../scenarios/hotelScenarios');
const fullBookingReportBuilder = require('../reporter/fullBookingReportBuilder');

// Flight journey steps (reuse)
const flightSearch = require('../engine2-journey/flight/flightSearch');
const flightResults = require('../engine2-journey/flight/flightResults');
const flightAddons = require('../engine2-journey/flight/flightAddons');
const passengerForm = require('../engine2-journey/flight/passengerForm');
const reviewPage = require('../engine2-journey/flight/reviewPage');

// Hotel journey steps (reuse)
const hotelSearch = require('../engine2-journey/hotel/hotelSearch');
const hotelResults = require('../engine2-journey/hotel/hotelResults');
const hotelRoomSelect = require('../engine2-journey/hotel/hotelRoomSelect');
const guestForm = require('../engine2-journey/hotel/guestForm');

const LOCK_PATH = path.join(__dirname, '..', 'state', 'bookingLock.json');

async function runFullBookingEngine() {
  // Gate check
  if (settings.BOOKING_FLOW_ENABLED !== 'true') {
    logger.info('[BOOKING] Engine disabled. Set BOOKING_FLOW_ENABLED=true in .env to activate.');
    return { skipped: true, reason: 'disabled_in_env' };
  }

  // File lock
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf-8'));
      if (lock.locked) {
        logger.warn(`[BOOKING] Lock active since ${lock.lockedAt}. Skipping.`);
        return { skipped: true, reason: 'lock_active' };
      }
    }
  } catch { /* proceed */ }

  fs.writeFileSync(LOCK_PATH, JSON.stringify({ locked: true, lockedAt: new Date().toISOString() }));

  const runId = `BOOKING-${new Date().toISOString().slice(0, 10)}`;
  const runData = {
    runId,
    startTime: new Date().toISOString(),
    flightBooking: null,
    hotelBooking: null,
    allPnrs: [],
  };

  let browser = null;

  try {
    // Pick simple domestic scenarios (lowest inventory impact)
    const flightScenario = FLIGHT_SCENARIOS.find(s => s.id === 'DOM-OW-ECO-1') || FLIGHT_SCENARIOS[0];
    const hotelScenario = HOTEL_SCENARIOS.find(s => s.id === 'HTL-DOM-2') || HOTEL_SCENARIOS[0];

    // Browser setup
    const browserResult = await browserModule.launch();
    browser = browserResult.browser;
    const page = browserResult.page;
    const urlTracker = new UrlTracker(runId);

    await login.authenticate(page);

    // Flight full booking
    logger.info('[BOOKING] Starting flight full booking test');
    runData.flightBooking = await runSingleBooking(page, {
      type: 'flight', scenario: flightScenario, urlTracker, runId,
    });
    if (runData.flightBooking.pnr) runData.allPnrs.push(runData.flightBooking.pnr);

    // Hotel full booking
    logger.info('[BOOKING] Starting hotel full booking test');
    runData.hotelBooking = await runSingleBooking(page, {
      type: 'hotel', scenario: hotelScenario, urlTracker, runId,
    });
    if (runData.hotelBooking.pnr) runData.allPnrs.push(runData.hotelBooking.pnr);

    // Save URL log
    await urlTracker.saveToFile();
    runData.urlLog = urlTracker.toHtmlTable();

    // Build report
    runData.endTime = new Date().toISOString();
    const reportPath = await fullBookingReportBuilder.build(runData);
    logger.info(`[BOOKING] Report: ${reportPath}`);

    return { success: true, reportPath, pnrs: runData.allPnrs };
  } catch (err) {
    logger.error(`[BOOKING] Engine error: ${err.message}`);
    if (runData.allPnrs.length > 0) {
      await alertOpsTeam(runData.allPnrs, err.message);
    }
    return { success: false, error: err.message, pnrs: runData.allPnrs };
  } finally {
    fs.writeFileSync(LOCK_PATH, JSON.stringify({ locked: false, releasedAt: new Date().toISOString() }));
    if (browser) { try { await browser.close(); } catch { /* ignore */ } }
  }
}

async function runSingleBooking(page, { type, scenario, urlTracker, runId }) {
  const result = {
    type, scenarioId: scenario.id, scenarioLabel: scenario.label,
    pnr: null, bookingRef: null,
    confirmationScreenshot: null, cancellationStatus: 'NOT_ATTEMPTED',
    cancellationScreenshot: null, validationResults: {}, bugs: [],
  };

  try {
    // Run through search -> results -> selection (reuse journey steps)
    if (type === 'flight') {
      await flightSearch.execute(page, scenario, runId);
      await flightResults.execute(page, scenario, runId);
      await flightAddons.execute(page, scenario, runId);
      // passengerForm uses regular fake data; for booking we need test passengers
      // but the form filling logic is the same — it will be overridden below
      await passengerForm.execute(page, scenario, runId);
      await reviewPage.execute(page, scenario, runId);
    } else {
      await hotelSearch.execute(page, scenario, runId);
      await hotelResults.execute(page, scenario, runId);
      await hotelRoomSelect.execute(page, scenario, runId);
      await guestForm.execute(page, scenario, runId);
    }

    await urlTracker.capture(page, `${type}-payment-page`);

    // Submit booking
    const submitResult = await bookingSubmitter.submit(page, settings.BOOKING_TEST_PAYMENT_METHOD || 'hold');
    if (!submitResult.success) {
      result.bugs.push({
        id: 'BOOKING-SUBMIT-FAIL', severity: 'P0',
        title: `Booking submission failed: ${submitResult.error}`,
        devFixRequired: 'Check payment/confirmation flow',
      });
      return result;
    }

    // Capture PNR
    await urlTracker.capture(page, `${type}-confirmation-page`);
    const pnrData = await pnrCapture.capture(page, type);
    result.pnr = pnrData.pnr;
    result.bookingRef = pnrData.bookingRef;
    result.confirmationScreenshot = pnrData.screenshot;

    // Validate confirmation screen
    result.validationResults = await bookingValidator.validate(page, type, pnrData);

    // CANCEL IMMEDIATELY
    if (settings.BOOKING_CANCEL_IMMEDIATELY !== 'false') {
      logger.info(`[BOOKING] PNR captured: ${result.pnr}. Cancelling now.`);
      const cancelResult = await bookingCanceller.cancel(page, result.pnr, result.bookingRef, type);
      result.cancellationStatus = cancelResult.status;
      result.cancellationScreenshot = cancelResult.screenshot;

      if (cancelResult.status !== 'CANCELLED') {
        logger.error(`[BOOKING] CANCELLATION FAILED for PNR: ${result.pnr}`);
        await alertOpsTeam([result.pnr], `Cancellation failed: ${cancelResult.error}`);
        result.bugs.push({
          id: 'BOOKING-CANCEL-FAIL', severity: 'P0',
          title: `Booking cancellation failed — PNR ${result.pnr} requires manual cancel`,
          description: cancelResult.error,
          devFixRequired: 'Check cancellation API and UI flow. Manual cancel required.',
          requiresManualAction: true, pnr: result.pnr,
        });
      }
    }
  } catch (err) {
    result.bugs.push({
      id: 'BOOKING-FLOW-ERROR', severity: 'P0',
      title: `Full booking flow error: ${err.message}`,
      devFixRequired: 'Review booking submission flow',
    });
    // Emergency cancel if PNR was captured
    if (result.pnr) {
      await bookingCanceller.cancel(page, result.pnr, result.bookingRef, type)
        .catch(e => logger.error(`[BOOKING] Emergency cancel also failed: ${e.message}`));
    }
  }

  return result;
}

async function alertOpsTeam(pnrs, reason) {
  const webhook = settings.BOOKING_SLACK_ALERT_WEBHOOK;
  if (!webhook) return;
  const message = {
    text: `*EQIS BOOKING ALERT*\nPNRs requiring manual cancellation:\n${pnrs.join(', ')}\nReason: ${reason}\nPlease cancel immediately.`,
  };
  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });
  } catch (e) {
    logger.error(`[BOOKING] Slack alert failed: ${e.message}`);
  }
}

module.exports = { runFullBookingEngine };
