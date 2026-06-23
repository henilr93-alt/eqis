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
  frakaEmailRequestsApi, frakaEmailPollApi, frakaEmailSendApi, frakaEmailSkipApi,
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

  // Password gate middleware (skip for SSE, static assets, login page, and healthcheck)
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/live')) return next();
    if (req.path.startsWith('/ui/')) return next();
    if (req.path === '/' || req.path === '/login') return next();
    // /api/status must be publicly accessible for Railway/uptime monitor healthchecks.
    // It returns only system health (no sensitive data), so safe to expose.
    if (req.path === '/api/status') return next();

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

  // Serve index with no-cache so the user always gets the latest dashboard
  app.get('/', (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.sendFile(path.join(__dirname, 'ui', 'index.html'));
  });

  // API routes
  app.get('/api/status', statusApi);
  app.get('/api/metrics', metricsApi);
  app.get('/api/history', historyApi);
  app.get('/api/download/:type/:filename', downloadApi);
  app.get('/api/download/:type/:a/:b/:c', downloadApi);  // nested paths for screenshots (type/pulseId/screenshots/file.png)
  app.get('/api/live', liveApi);
  const { liveTodayByEngineApi } = require('./api/liveTodayApi');
  app.get('/api/live/today-by-engine', liveTodayByEngineApi);
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

  // FRAKA Failure Auditor — view rule book + audit findings, trigger on-demand audit
  const { runAuditCycle, loadRuleBook, loadFindings } = require('../fraka/tools/failureAuditor');
  app.get('/api/fraka/audit/rulebook', (req, res) => res.json(loadRuleBook()));
  app.get('/api/fraka/audit/findings', (req, res) => {
    const data = loadFindings();
    const limit = parseInt(req.query.limit, 10) || 50;
    const sideFilter = req.query.side; // optional: 'etrav' | 'eqis' | 'unclear'
    let findings = data.findings.slice().reverse(); // newest first
    if (sideFilter) findings = findings.filter(f => f.side === sideFilter);
    findings = findings.slice(0, limit);
    res.json({ ...data, findings });
  });
  app.post('/api/fraka/audit/run', async (req, res) => {
    try {
      const hoursBack = parseInt(req.body?.hoursBack, 10) || 6;
      const maxAudits = parseInt(req.body?.maxAudits, 10) || 5;
      const result = await runAuditCycle({ hoursBack, maxAudits });
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
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
  // FRAKA email reply (Engine 9 Leg 1) — read tech-team inbox replies, draft + send run details
  app.get('/api/fraka/email-requests', frakaEmailRequestsApi);
  app.post('/api/fraka/email-requests/poll', frakaEmailPollApi);
  app.post('/api/fraka/email-requests/:id/send', frakaEmailSendApi);
  app.post('/api/fraka/email-requests/:id/skip', frakaEmailSkipApi);

  // ECD comparison engine (engine5-ecd + engine6-mirror + ecd-comparator)
  const {
    ecdStatusApi, ecdLatestApi, ecdHistoryApi, ecdDestinationsApi, ecdRunNowApi, ecdActivityApi, ecdProgressApi, ecdNotesListApi, ecdNotesGetApi, ecdNotesSaveApi, ecdExportCsvApi, ecdCeoMetricsApi, ecdPortfolioApi,
  } = require('./api/ecdApi');
  app.get('/api/ecd/status', ecdStatusApi);
  app.get('/api/ecd/activity', ecdActivityApi);
  app.get('/api/ecd/progress', ecdProgressApi);
  app.get('/api/ecd/notes', ecdNotesListApi);
  app.get('/api/ecd/notes/:hotel', ecdNotesGetApi);
  app.post('/api/ecd/notes/:hotel', ecdNotesSaveApi);
  app.get('/api/ecd/export.csv', ecdExportCsvApi);
  app.get('/api/ecd/ceo-metrics', ecdCeoMetricsApi);
  app.get('/api/ecd/portfolio', ecdPortfolioApi);
  app.get('/api/ecd/latest', ecdLatestApi);
  app.get('/api/ecd/history', ecdHistoryApi);
  app.get('/api/ecd/destinations', ecdDestinationsApi);
  app.post('/api/ecd/run-now', ecdRunNowApi);

  // SearchPulse activity bars (History tab live status — one per sub-engine)
  const { searchPulseActivityApi } = require('./api/searchpulseActivityApi');
  app.get('/api/searchpulse/activity', searchPulseActivityApi);

  // Review tab — Flight INTL Review Pulse (engine 8). Placed between
  // History and Supplier Health per CEO request 2026-06-13.
  const reviewApi = require('./api/reviewApi');
  app.get('/api/review/status',                 reviewApi.reviewStatusApi);
  app.get('/api/review/today',                  reviewApi.reviewTodayApi);
  app.get('/api/review/history',                reviewApi.reviewHistoryApi);
  app.get('/api/review/failures',               reviewApi.reviewFailuresApi);
  app.get('/api/review/rotation',               reviewApi.reviewRotationApi);
  app.get('/api/review/asset/:kind/:runId',     reviewApi.reviewAssetApi);
  app.get('/api/review/detail/:runId',          reviewApi.reviewDetailApi);

  // Flight INTL Audit tab — Engine 9 (merged search + book + review on ONE page).
  // ADDITIVE: runs alongside the legacy Review tab until the merged engine is
  // verified (user constraint 2026-06-18 — keep both engines until proven).
  const fiaApi = require('./api/flightIntlAuditApi');
  app.get('/api/flight-intl-audit/status',            fiaApi.flightIntlAuditStatusApi);
  app.get('/api/flight-intl-audit/today',             fiaApi.flightIntlAuditTodayApi);
  app.get('/api/flight-intl-audit/history',           fiaApi.flightIntlAuditHistoryApi);
  app.get('/api/flight-intl-audit/failures',          fiaApi.flightIntlAuditFailuresApi);
  app.get('/api/flight-intl-audit/asset/:kind/:runId', fiaApi.flightIntlAuditAssetApi);
  app.get('/api/flight-intl-audit/detail/:runId',     fiaApi.flightIntlAuditDetailApi);
  app.get('/api/flight-intl-audit/verifications',     fiaApi.flightIntlAuditVerificationsApi);
  app.get('/api/flight-intl-audit/escalation-summary', fiaApi.flightIntlAuditEscalationSummaryApi);

  // Supplier Health tab — Flight INTL airline filter trends
  const { supplierHealthMatrixApi, supplierHealthSectorApi, supplierHealthScreenshotApi } = require('./api/supplierHealthApi');
  app.get('/api/supplier-health/matrix', supplierHealthMatrixApi);
  app.get('/api/supplier-health/sector', supplierHealthSectorApi);
  app.get('/api/supplier-health/screenshot', supplierHealthScreenshotApi);
  // Competitor (engine 7) routes removed 2026-06-14 per user request

  // Notifications tab — daily-digest email roster + send history + manual triggers
  const emailApi = require('./api/emailApi');
  app.get('/api/email/status',     emailApi.statusApi);
  app.get('/api/email/roster',     emailApi.getRosterApi);
  app.post('/api/email/roster',    emailApi.postRosterApi);
  app.get('/api/email/history',    emailApi.historyApi);
  app.get('/api/email/schedule',   emailApi.scheduleApi);
  app.post('/api/email/send-test', emailApi.sendTestApi);
  app.post('/api/email/run-now',   emailApi.runNowApi);

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