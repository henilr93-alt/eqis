// Dashboard-only launcher — starts the Express dashboard WITHOUT booting the
// browser-automation engines or cron jobs. Used to verify UI/API changes safely.
require('dotenv').config();
const { startDashboard } = require('../dashboard/server');
startDashboard();
