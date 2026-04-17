const cronManager = require('../../utils/cronManager');
const logger = require('../../utils/logger');

// Import all engine classes
const SearchPulseEngine = require('../../engine3-searchpulse/searchPulseEngine');
const JourneyEngine = require('../../engine2-journey/journeyEngine');
const ZipyEngine = require('../../engine1-zipy/zipyEngine');
const FullBookingEngine = require('../../engine4-fullbooking/fullBookingEngine');

/**
 * Start all EQIS engines and force immediate first runs
 * Returns status summary for all engines
 */
async function startAllEngines() {
  try {
    logger.info('FRAKA: Starting all EQIS engines...');
    
    // Start all cron jobs
    const startResults = cronManager.startAll();
    
    // Create engine instances for force runs
    const engines = {
      searchPulse: new SearchPulseEngine(),
      journey: new JourneyEngine(),
      zipy: new ZipyEngine(),
      fullBooking: new FullBookingEngine()
    };
    
    // Force immediate first run for each engine
    const forceResults = {};
    
    // SearchPulse - immediate run
    forceResults.searchPulse = await cronManager.forceRun('searchPulse', async () => {
      await engines.searchPulse.run();
    });
    
    // Journey - immediate run
    forceResults.journey = await cronManager.forceRun('journey', async () => {
      await engines.journey.run();
    });
    
    // Zipy - immediate run (following CEO directive: 5 random sessions every 10 min)
    forceResults.zipy = await cronManager.forceRun('zipy', async () => {
      await engines.zipy.run();
    });
    
    // FullBooking - immediate run (if enabled)
    const bookingEnabled = process.env.BOOKING_FLOW_ENABLED === 'true';
    if (bookingEnabled) {
      forceResults.fullBooking = await cronManager.forceRun('fullBooking', async () => {
        await engines.fullBooking.run();
      });
    } else {
      forceResults.fullBooking = { success: true, note: 'Skipped - BOOKING_FLOW_ENABLED=false' };
    }
    
    // Wait a moment for state to stabilize
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Get final status of all engines
    const finalStatus = cronManager.getAllStatus();
    
    const summary = {
      action: 'start_all_engines',
      timestamp: new Date().toISOString(),
      cronStartResults: startResults,
      forceRunResults: forceResults,
      finalStatus: finalStatus,
      healthSummary: generateHealthSummary(finalStatus, forceResults)
    };
    
    logger.info('FRAKA: All engines started successfully');
    return summary;
    
  } catch (error) {
    logger.error('FRAKA: Failed to start all engines:', error);
    throw error;
  }
}

/**
 * Generate a health summary for CEO reporting
 */
function generateHealthSummary(status, forceResults) {
  const summary = {
    enginesRunning: 0,
    enginesPaused: 0,
    lastRunSuccess: 0,
    lastRunFailed: 0,
    overallHealth: 'unknown'
  };
  
  for (const [engine, engineStatus] of Object.entries(status)) {
    if (engineStatus.status === 'running') {
      summary.enginesRunning++;
    } else {
      summary.enginesPaused++;
    }
    
    if (forceResults[engine]?.success) {
      summary.lastRunSuccess++;
    } else {
      summary.lastRunFailed++;
    }
  }
  
  // Overall health assessment
  if (summary.enginesRunning === 4 && summary.lastRunSuccess >= 3) {
    summary.overallHealth = 'excellent';
  } else if (summary.enginesRunning >= 3 && summary.lastRunSuccess >= 2) {
    summary.overallHealth = 'good';
  } else if (summary.enginesRunning >= 2) {
    summary.overallHealth = 'fair';
  } else {
    summary.overallHealth = 'poor';
  }
  
  return summary;
}

module.exports = {
  startAllEngines,
  generateHealthSummary
};