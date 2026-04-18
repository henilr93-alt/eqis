const express = require('express');
const path = require('path');
const settings = require('../config/settings');
const logger = require('../utils/logger');

const { statusApi } = require('./api/statusApi');
const { metricsApi } = require('./api/metricsApi');
const { historyApi } = require('./api/historyApi');
const { downloadApi } = require('./api/downloadApi');
const { liveApi } = require('./api/liveApi');
const { costApi } = require('./api/costApi');
const { getIntervalsApi, postIntervalsApi } = require('./api/intervalsApi');
const { getEnginesApi, toggleEngineApi, startAllApi, stopAllApi } = require('./api/enginesApi');
const { submitOtpApi, getLatestOtpApi, otpHistoryApi } = require('./api/otpApi');
const {
  frakaStatusApi, frakaWakeApi, frakaSleepApi,
  frakaChatApi, frakaChatHistoryApi,
  frakaChatMessageActionApi, frakaChatClearApi,
  frakaProposalsApi, frakaApproveProposalApi, frakaRejectProposalApi,
  frakaReviewNowApi, frakaFeedbackApi, frakaFeedbackListApi,
  frakaPainPointsApi, frakaPainPointsRefreshApi,
  frakaDevelopmentsApi, frakaDevelopmentActionApi,
  frakaCodeTreeApi, frakaCodeListApi, frakaCodeReadApi, frakaCodeSearchApi,
  frakaCoderBuildApi, frakaCoderHistoryApi, frakaCoderBuildDetailApi,
  frakaDirectivesListApi, frakaDirectivesAddApi, frakaDirectivesUpdateApi, frakaDirectivesDeleteApi,
  frakaPerformanceApi,
} = require('./api/frakaApi');

function startDashboard() {
  if (settings.DASHBOARD_ENABLED !== 'true') {
    logger.info('[DASHBOARD] Disabled. Set DASHBOARD_ENABLED=true to activate.');
    return;
  }

  const app = express();
  // Railway/Render/Heroku set process.env.PORT dynamically — respect it.
  // Fall back to settings.DASHBOARD_PORT or 4000 for local dev.
  const PORT = process.env.PORT || settings.DASHBOARD_PORT || 4000;
  const PASSWORD = settings.DASHBOARD_PASSWORD;

  // JSON body parser (for POST endpoints)
  app.use(express.json());

  // Password gate middleware (skip for SSE, static assets, and login page)
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/live')) return next();
    if (req.path.startsWith('/ui/')) return next();
    if (req.path === '/' || req.path === '/login') return next();

    if (PASSWORD) {
      const token = req.query.token || req.headers['x-dashboard-token'];
      if (token !== PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }
    next();
  });

  // Static files
  app.use('/ui', express.static(path.join(__dirname, 'ui')));

  // Serve index
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'ui', 'index.html'));
  });

  // API routes
  app.get('/api/status', statusApi);
  app.get('/api/metrics', metricsApi);
  app.get('/api/history', historyApi);
  app.get('/api/download/:type/:filename', downloadApi);
  app.get('/api/download/:type/:a/:b/:c', downloadApi);  // nested paths for screenshots (type/pulseId/screenshots/file.png)
  app.get('/api/live', liveApi);
  app.get('/api/cost', costApi);

  // Per-search individual report
  const { searchReportApi } = require('./api/searchReportApi');
  app.get('/api/search-report', searchReportApi);

  // Rulebook last-updated tracker
  let rulebookLastUpdated = new Date().toISOString();
  app.get('/api/rulebook/status', (req, res) => {
    res.json({ lastUpdated: rulebookLastUpdated, updatedBy: 'FRAKA hourly review' });
  });
  app.post('/api/rulebook/update', (req, res) => {
    rulebookLastUpdated = new Date().toISOString();
    res.json({ success: true, lastUpdated: rulebookLastUpdated });
  });
  app.get('/api/intervals', getIntervalsApi);
  app.post('/api/intervals', postIntervalsApi);
  app.get('/api/engines', getEnginesApi);
  app.post('/api/engines/all/start', startAllApi);
  app.post('/api/engines/all/stop', stopAllApi);
  app.post('/api/engines/:name/toggle', toggleEngineApi);

  // OTP management endpoints
  app.post('/api/otp/submit', submitOtpApi);
  app.get('/api/otp/latest', getLatestOtpApi);
  app.get('/api/otp/history', otpHistoryApi);

  // FRAKA sub-CTO agent
  app.get('/api/fraka/status', frakaStatusApi);
  app.post('/api/fraka/wake', frakaWakeApi);
  app.post('/api/fraka/sleep', frakaSleepApi);
  app.post('/api/fraka/chat', frakaChatApi);
  app.get('/api/fraka/chat/:role', frakaChatHistoryApi);
  app.post('/api/fraka/chat/:role/message/:id', frakaChatMessageActionApi);
  app.post('/api/fraka/chat/:role/clear', frakaChatClearApi);
  app.get('/api/fraka/proposals', frakaProposalsApi);
  app.post('/api/fraka/proposals/:id/approve', frakaApproveProposalApi);
  app.post('/api/fraka/proposals/:id/reject', frakaRejectProposalApi);
  app.post('/api/fraka/review-now', frakaReviewNowApi);
  app.post('/api/fraka/feedback', frakaFeedbackApi);
  app.get('/api/fraka/feedback', frakaFeedbackListApi);
  app.get('/api/fraka/painpoints', frakaPainPointsApi);
  app.post('/api/fraka/painpoints/refresh', frakaPainPointsRefreshApi);
  app.get('/api/fraka/developments', frakaDevelopmentsApi);
  app.post('/api/fraka/developments/:id/action', frakaDevelopmentActionApi);
  // Code browser (read-only)
  app.get('/api/fraka/code/tree', frakaCodeTreeApi);
  app.get('/api/fraka/code/list', frakaCodeListApi);
  app.get('/api/fraka/code/read', frakaCodeReadApi);
  app.get('/api/fraka/code/search', frakaCodeSearchApi);
  // Autonomous coder build pipeline
  app.post('/api/fraka/build', frakaCoderBuildApi);
  app.get('/api/fraka/builds', frakaCoderHistoryApi);
  app.get('/api/fraka/builds/:id', frakaCoderBuildDetailApi);
  // CEO directives (persistent rules FRAKA must obey)
  app.get('/api/fraka/directives', frakaDirectivesListApi);
  app.post('/api/fraka/directives', frakaDirectivesAddApi);
  app.patch('/api/fraka/directives/:id', frakaDirectivesUpdateApi);
  app.delete('/api/fraka/directives/:id', frakaDirectivesDeleteApi);
  app.get('/api/fraka/performance', frakaPerformanceApi);

  // Bind to 0.0.0.0 so platforms like Railway/Render can route external traffic.
  // Falls back to localhost only if explicitly requested via DASHBOARD_HOST=localhost.
  const HOST = process.env.DASHBOARD_HOST || '0.0.0.0';
  app.listen(PORT, HOST, () => {
    logger.info(`[DASHBOARD] Running at http://${HOST}:${PORT}`);
    console.log(`\n  ┌─────────────────────────────────────────┐`);
    console.log(`  │  Dashboard: http://${HOST}:${PORT}             │`);
    console.log(`  └─────────────────────────────────────────┘\n`);
  });
}

module.exports = { startDashboard };