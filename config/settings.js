const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });

const REQUIRED_VARS = [
  'ETRAV_BASE_URL',
  'ETRAV_AGENT_EMAIL',
  'ETRAV_AGENT_PASSWORD',
  'ZIPY_BASE_URL',
  'ZIPY_EMAIL',
  'ZIPY_PASSWORD',
  'ANTHROPIC_API_KEY',
  'CLAUDE_MODEL',
];

const PLACEHOLDER_VALUES = ['your_key_here', 'your_test_password', 'your_zipy_password', 'your_zipy_login@etrav.in'];

function validateEnv() {
  const cmd = process.argv[2];
  // Allow --help and status without real credentials
  if (cmd === '--help' || cmd === '-h' || cmd === 'status') return;

  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables:\n  ${missing.join('\n  ')}\nCheck your .env file.`
    );
  }

  const placeholders = REQUIRED_VARS.filter(
    (key) => PLACEHOLDER_VALUES.includes(process.env[key])
  );
  if (placeholders.length > 0) {
    console.warn(
      `WARNING: These variables still have placeholder values:\n  ${placeholders.join('\n  ')}\nUpdate your .env file with real credentials before running engines.`
    );
  }
}

validateEnv();

module.exports = {
  // Memory-constrained env (e.g. Railway 512MB): set MAX_PARALLEL_SEARCHES=1
  // to run searches serially instead of 4-at-a-time. Set RECORDING_ENABLED=false
  // to skip MP4 recording (biggest ffmpeg memory spike).
  MAX_PARALLEL_SEARCHES: parseInt(process.env.MAX_PARALLEL_SEARCHES || '4', 10),
  RECORDING_ENABLED: (process.env.RECORDING_ENABLED || 'true').toLowerCase() !== 'false',

  // Etrav
  ETRAV_BASE_URL: process.env.ETRAV_BASE_URL,
  ETRAV_AGENT_EMAIL: process.env.ETRAV_AGENT_EMAIL,
  ETRAV_AGENT_PASSWORD: process.env.ETRAV_AGENT_PASSWORD,

  // Zipy
  ZIPY_BASE_URL: process.env.ZIPY_BASE_URL,
  ZIPY_EMAIL: process.env.ZIPY_EMAIL,
  ZIPY_PASSWORD: process.env.ZIPY_PASSWORD,
  ZIPY_SESSIONS_TO_HARVEST: parseInt(process.env.ZIPY_SESSIONS_TO_HARVEST || '50', 10),
  ZIPY_SESSIONS_TO_DEEP_ANALYZE: parseInt(process.env.ZIPY_SESSIONS_TO_DEEP_ANALYZE || '8', 10),
  ZIPY_DAILY_RUN_HOUR: parseInt(process.env.ZIPY_DAILY_RUN_HOUR || '6', 10),

  // AI
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  CLAUDE_MODEL: process.env.CLAUDE_MODEL,
  // FRAKA sub-CTO agent models
  FRAKA_CHAT_MODEL: process.env.FRAKA_CHAT_MODEL || 'claude-haiku-4-5',
  FRAKA_ANALYSIS_MODEL: process.env.FRAKA_ANALYSIS_MODEL || process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',

  // System
  JOURNEY_RUN_INTERVAL_MINUTES: parseInt(process.env.JOURNEY_RUN_INTERVAL_MINUTES || '30', 10),
  HEADLESS: process.env.HEADLESS !== 'false',
  REPORT_DIR: path.resolve(process.env.REPORT_DIR || './reports'),
  LOG_DIR: path.resolve(process.env.LOG_DIR || './logs'),
  TIMEZONE: process.env.TIMEZONE || 'Asia/Kolkata',

  // Dashboard
  DASHBOARD_PORT: parseInt(process.env.DASHBOARD_PORT || '4000', 10),
  DASHBOARD_PASSWORD: null, // Password disabled — set via .env DASHBOARD_PASSWORD to re-enable
  DASHBOARD_ENABLED: process.env.DASHBOARD_ENABLED || 'false',

  // Full Booking Engine (Engine 4)
  BOOKING_FLOW_ENABLED: process.env.BOOKING_FLOW_ENABLED || 'false',
  BOOKING_TEST_PAYMENT_METHOD: process.env.BOOKING_TEST_PAYMENT_METHOD || 'hold',
  BOOKING_CANCEL_IMMEDIATELY: process.env.BOOKING_CANCEL_IMMEDIATELY || 'true',
  BOOKING_RUN_HOUR: parseInt(process.env.BOOKING_RUN_HOUR || '2', 10),
  BOOKING_SLACK_ALERT_WEBHOOK: process.env.BOOKING_SLACK_ALERT_WEBHOOK || null,

  // CMT Escalation (auto-report issues to Etrav tech team — runs headless)
  CMT_ESCALATION_ENABLED: process.env.CMT_ESCALATION_ENABLED || 'true',

  // Optional
  SLACK_WEBHOOK_URL: process.env.SLACK_WEBHOOK_URL || null,
};
