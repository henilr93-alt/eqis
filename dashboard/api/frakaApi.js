// FRAKA dashboard API — chat, proposals, review, feedback, status, pain-points, developments.
const logger = require('../../utils/logger');
const { handleChatMessage } = require('../../fraka/agent');
const { runHourlyReview, readFrakaState, writeFrakaState } = require('../../fraka/reviewer');
const conversationStore = require('../../fraka/conversationStore');
const proposalsStore = require('../../fraka/proposalsStore');
const developmentsStore = require('../../fraka/developmentsStore');
const { getSystemStatus } = require('../../fraka/tools/systemStatus');
const { budgetCheck } = require('../../fraka/tools/budgetCheck');
const { appendFeedback, getRecentFeedback } = require('../../fraka/tools/techFeedback');
const { refreshPainPoints, getCachedReport } = require('../../fraka/tools/painPointAnalyzer');
const codeReader = require('../../fraka/tools/codeReader');
const coder = require('../../fraka/coder');
const ceoDirectives = require('../../fraka/ceoDirectives');
const cronManager = require('../../utils/cronManager');

// ── Status ────────────────────────────────────────────────
function frakaStatusApi(req, res) {
  try {
    const frakaState = readFrakaState();
    const budget = budgetCheck();
    const system = getSystemStatus();
    const pending = proposalsStore.listProposals({ status: 'pending' });

    res.json({
      fraka: {
        active: frakaState.active === true,
        awakenedAt: frakaState.awakenedAt || null,
        sleptAt: frakaState.sleptAt || null,
        lastReviewAt: frakaState.lastReviewAt || null,
        lastReviewSummary: frakaState.lastReviewSummary || null,
        lastHeadlineMetrics: frakaState.lastHeadlineMetrics || null,
        criticalAlerts: frakaState.criticalAlerts || [],
        totalReviews: frakaState.totalReviews || 0,
        approvedSpendUsd: frakaState.approvedSpendUsd || 50,
        approvedUntil: frakaState.approvedUntil || null,
      },
      budget,
      system: {
        systemStatus: system.systemStatus,
        currentSearchHealth: system.currentSearchHealth,
        engineStates: system.engineStates,
        intervals: system.intervals,
      },
      pendingCounts: {
        total: pending.length,
        ceo: pending.filter(p => p.audience === 'ceo' || p.audience === 'both').length,
        tech: pending.filter(p => p.audience === 'tech' || p.audience === 'both').length,
      },
    });
  } catch (err) {
    logger.error('[FRAKA-API] status failed: ' + err.message);
    res.status(500).json({ error: err.message });
  }
}

// ── Wake / Sleep FRAKA (gates all EQIS operations) ─────────
function frakaWakeApi(req, res) {
  try {
    const state = readFrakaState();
    state.active = true;
    state.awakenedAt = new Date().toISOString();
    writeFrakaState(state);
    try { cronManager.resumeAllEngines(); } catch (e) { logger.warn('[FRAKA-API] resumeAllEngines failed: ' + e.message); }
    logger.info('[FRAKA-API] ☀ FRAKA woken up — all engines resumed');
    try {
      conversationStore.appendMessage('ceo', {
        sender: 'fraka',
        text: '☀ I am awake. All EQIS engines are running and I am back on duty. I will start analysing and reporting again.',
        tag: 'wakeup',
      });
      conversationStore.appendMessage('tech', {
        sender: 'fraka',
        text: '☀ Wake-up complete. Engines resumed, hourly review is armed, @file mentions are live. Send me a task and I will build it.',
        tag: 'wakeup',
      });
    } catch { /* ignore */ }
    res.json({ success: true, active: true, awakenedAt: state.awakenedAt });
  } catch (err) {
    logger.error('[FRAKA-API] wake failed: ' + err.message);
    res.status(500).json({ error: err.message });
  }
}

function frakaSleepApi(req, res) {
  try {
    const state = readFrakaState();
    state.active = false;
    state.sleptAt = new Date().toISOString();
    writeFrakaState(state);
    try { cronManager.pauseAllEngines(); } catch (e) { logger.warn('[FRAKA-API] pauseAllEngines failed: ' + e.message); }
    logger.info('[FRAKA-API] 💤 FRAKA is sleeping — all engines paused');
    try {
      conversationStore.appendMessage('ceo', {
        sender: 'fraka',
        text: '💤 Going to sleep. All EQIS engines have been paused. Nothing will run and I will not respond until you wake me up.',
        tag: 'sleep',
      });
      conversationStore.appendMessage('tech', {
        sender: 'fraka',
        text: '💤 Sleeping. Engines paused, hourly review disabled, chat responses disabled. Wake me up from the dashboard to resume.',
        tag: 'sleep',
      });
    } catch { /* ignore */ }
    res.json({ success: true, active: false, sleptAt: state.sleptAt });
  } catch (err) {
    logger.error('[FRAKA-API] sleep failed: ' + err.message);
    res.status(500).json({ error: err.message });
  }
}

// ── Chat ──────────────────────────────────────────────────
async function frakaChatApi(req, res) {
  try {
    const { role, message, replyTo } = req.body || {};
    if (!['ceo', 'tech'].includes(role)) {
      return res.status(400).json({ error: 'role must be "ceo" or "tech"' });
    }
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }

    // Sanitize replyTo — accept only the expected shape
    let cleanReplyTo = null;
    if (replyTo && typeof replyTo === 'object' && replyTo.id) {
      cleanReplyTo = {
        id: String(replyTo.id).slice(0, 60),
        sender: replyTo.sender === 'user' ? 'user' : 'fraka',
        textExcerpt: String(replyTo.textExcerpt || '').slice(0, 240),
      };
    }

    const result = await handleChatMessage(role, message.trim(), cleanReplyTo);
    res.json({
      success: !result.error,
      reply: result.reply,
      newProposals: result.newProposals || [],
      error: result.error || null,
    });
  } catch (err) {
    logger.error('[FRAKA-API] chat failed: ' + err.message);
    res.status(500).json({ error: err.message });
  }
}

// ── Chat history ──────────────────────────────────────────
function frakaChatHistoryApi(req, res) {
  try {
    const { role } = req.params;
    if (!['ceo', 'tech'].includes(role)) {
      return res.status(400).json({ error: 'role must be "ceo" or "tech"' });
    }
    const history = conversationStore.loadHistory(role);
    res.json({ role, messages: history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── Chat message action (edit/delete/star/pin/react) ─────
function frakaChatMessageActionApi(req, res) {
  try {
    const { role, id } = req.params;
    if (!['ceo', 'tech'].includes(role)) {
      return res.status(400).json({ error: 'role must be "ceo" or "tech"' });
    }
    const { action, text, emoji } = req.body || {};

    let updated;
    switch (action) {
      case 'edit':
        if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text is required for edit' });
        updated = conversationStore.updateMessage(role, id, { text: text.trim() });
        break;
      case 'delete':
        updated = conversationStore.updateMessage(role, id, { deleted: true });
        break;
      case 'star':
        updated = conversationStore.updateMessage(role, id, { starred: true });
        break;
      case 'unstar':
        updated = conversationStore.updateMessage(role, id, { starred: false });
        break;
      case 'pin':
        updated = conversationStore.updateMessage(role, id, { pinned: true });
        break;
      case 'unpin':
        updated = conversationStore.updateMessage(role, id, { pinned: false });
        break;
      case 'react':
        if (!emoji || typeof emoji !== 'string') return res.status(400).json({ error: 'emoji required for react' });
        updated = conversationStore.toggleReaction(role, id, emoji, 'user');
        break;
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }

    if (!updated) return res.status(404).json({ error: 'Message not found' });
    res.json({ success: true, message: updated });
  } catch (err) {
    logger.error('[FRAKA-API] chat message action failed: ' + err.message);
    res.status(500).json({ error: err.message });
  }
}

// ── Clear chat ─────────────────────────────────────────────
function frakaChatClearApi(req, res) {
  try {
    const { role } = req.params;
    if (!['ceo', 'tech'].includes(role)) {
      return res.status(400).json({ error: 'role must be "ceo" or "tech"' });
    }
    conversationStore.clearHistory(role);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── Proposals list ────────────────────────────────────────
function frakaProposalsApi(req, res) {
  try {
    const { status, audience } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (audience) filter.audience = audience;
    const list = proposalsStore.listProposals(filter);
    res.json({ proposals: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── Approve proposal — this is where changes actually execute ─
async function frakaApproveProposalApi(req, res) {
  try {
    const { id } = req.params;
    const { approver } = req.body || {};
    const approverName = approver || 'unknown';

    const proposal = proposalsStore.getProposal(id);
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
    if (proposal.status !== 'pending') {
      return res.status(400).json({ error: `Proposal already ${proposal.status}` });
    }

    // Execute the change based on proposal type
    const executionResult = await executeProposal(proposal);

    // Mark approved
    const approved = proposalsStore.approveProposal(id, approverName);
    proposalsStore.updateProposal(id, { executionResult });

    logger.info(`[FRAKA-API] Proposal ${id} approved by ${approverName} — result: ${executionResult.status}`);

    res.json({
      success: true,
      proposal: { ...approved, executionResult },
    });
  } catch (err) {
    logger.error('[FRAKA-API] approve failed: ' + err.message);
    res.status(500).json({ error: err.message });
  }
}

// ── Reject proposal ───────────────────────────────────────
function frakaRejectProposalApi(req, res) {
  try {
    const { id } = req.params;
    const { rejector } = req.body || {};
    const rejectorName = rejector || 'unknown';

    const proposal = proposalsStore.getProposal(id);
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
    if (proposal.status !== 'pending') {
      return res.status(400).json({ error: `Proposal already ${proposal.status}` });
    }

    const rejected = proposalsStore.rejectProposal(id, rejectorName);
    logger.info(`[FRAKA-API] Proposal ${id} rejected by ${rejectorName}`);
    res.json({ success: true, proposal: rejected });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── Manual review trigger ─────────────────────────────────
async function frakaReviewNowApi(req, res) {
  try {
    // Fire and forget so the caller doesn't wait 30+ seconds
    runHourlyReview()
      .then(r => logger.info('[FRAKA-API] Manual review complete'))
      .catch(err => logger.error('[FRAKA-API] Manual review failed: ' + err.message));
    res.json({ success: true, message: 'Review started. Check chat in 30-60 seconds for the summary.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── Tech feedback submission ──────────────────────────────
function frakaFeedbackApi(req, res) {
  try {
    const { note, author } = req.body || {};
    if (!note || typeof note !== 'string' || !note.trim()) {
      return res.status(400).json({ error: 'note is required' });
    }
    const entry = appendFeedback(note.trim(), author || 'tech');
    res.json({ success: true, feedback: entry });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function frakaFeedbackListApi(req, res) {
  try {
    res.json({ feedback: getRecentFeedback(50) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── Proposal execution dispatcher ─────────────────────────
async function executeProposal(proposal) {
  const { type, details } = proposal;

  try {
    switch (type) {
      case 'interval_change': {
        const updates = {};
        if (details.searchPulseMinutes) updates.searchPulseMinutes = details.searchPulseMinutes;
        if (details.journeyMinutes) updates.journeyMinutes = details.journeyMinutes;
        if (details.fullBookingMinutes) updates.fullBookingMinutes = details.fullBookingMinutes;
        if (Object.keys(updates).length === 0) {
          return { status: 'noop', message: 'No interval fields to update' };
        }
        const result = cronManager.updateIntervals(updates);
        return { status: 'executed', message: 'Intervals updated', applied: updates, newState: result };
      }

      case 'engine_toggle': {
        const engine = details.engine;
        const enabled = details.enabled;
        if (!engine || typeof enabled !== 'boolean') {
          return { status: 'error', message: 'engine and enabled required' };
        }
        cronManager.setEngineEnabled(engine, enabled);
        return { status: 'executed', message: `Engine ${engine} ${enabled ? 'started' : 'stopped'}` };
      }

      case 'pause_all': {
        const state = cronManager.pauseAllEngines();
        return { status: 'executed', message: 'All engines paused', newState: state };
      }

      case 'resume_all': {
        const state = cronManager.resumeAllEngines();
        return { status: 'executed', message: 'All engines resumed (except fullBooking)', newState: state };
      }

      case 'spend_approval': {
        const cap = parseFloat(details.capUsd || 50);
        const hours = parseInt(details.hours || 24, 10);
        const approvedUntil = new Date(Date.now() + hours * 3600 * 1000).toISOString();
        const state = readFrakaState();
        state.approvedSpendUsd = cap;
        state.approvedUntil = approvedUntil;
        writeFrakaState(state);
        return { status: 'executed', message: `Spend cap raised to $${cap} for ${hours}h`, approvedUntil };
      }

      case 'code_suggestion': {
        // Text-only suggestion — not applied to disk.
        return { status: 'noop', message: 'Code suggestion acknowledged. Apply manually or convert to a code_change proposal.' };
      }

      case 'code_change': {
        // FRAKA-authored file create/update/delete — applied to disk with backup.
        const filePath = details.filePath || details.file;
        const operation = (details.operation || 'update').toLowerCase();
        if (!filePath) {
          return { status: 'error', message: 'code_change requires details.filePath' };
        }
        if (!['create', 'update', 'delete'].includes(operation)) {
          return { status: 'error', message: `Invalid operation: ${operation}` };
        }
        try {
          const result = codeReader.writeProjectFile(filePath, details.content || '', operation);
          return {
            status: 'executed',
            message: `code_change ${operation} applied to ${result.relPath}`,
            ...result,
          };
        } catch (err) {
          return { status: 'error', message: `code_change failed: ${err.message}` };
        }
      }

      case 'scenario_edit': {
        // Scenario edits go through the same safe writer as code_change.
        const filePath = details.file || details.filePath;
        const content = details.patch || details.content || '';
        if (!filePath || !content) {
          return { status: 'noop', message: 'scenario_edit missing file/patch — apply manually.' };
        }
        try {
          const result = codeReader.writeProjectFile(filePath, content, 'update');
          return { status: 'executed', message: `scenario_edit applied to ${result.relPath}`, ...result };
        } catch (err) {
          return { status: 'error', message: `scenario_edit failed: ${err.message}` };
        }
      }

      default:
        return { status: 'error', message: `Unknown proposal type: ${type}` };
    }
  } catch (err) {
    logger.error(`[FRAKA-API] executeProposal(${type}) failed: ${err.message}`);
    return { status: 'error', message: err.message };
  }
}

// ── Pain-point dashboard (bugs + developments) ──────────────
function frakaPainPointsApi(req, res) {
  try {
    const report = getCachedReport();
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function frakaPainPointsRefreshApi(req, res) {
  try {
    // Fire-and-forget so the caller isn't blocked for 20+ seconds
    const windowHours = parseInt(req.query.windowHours, 10) || 168;
    refreshPainPoints(windowHours)
      .then(() => logger.info('[FRAKA-API] Pain-point refresh complete'))
      .catch(err => logger.error('[FRAKA-API] Pain-point refresh failed: ' + err.message));
    res.json({ success: true, message: 'Pain-point analysis started. Check back in 30-60 seconds.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── Code browser (read-only browse of the EQIS project) ────
function frakaCodeTreeApi(req, res) {
  try {
    const tree = codeReader.buildProjectTree({ maxDepth: 4 });
    res.json({ root: 'eqis', tree });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function frakaCodeListApi(req, res) {
  try {
    const dir = req.query.dir || '';
    res.json({ entries: codeReader.listProjectDir(dir) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

function frakaCodeReadApi(req, res) {
  try {
    const p = req.query.path;
    if (!p) return res.status(400).json({ error: 'path is required' });
    const rec = codeReader.readProjectFile(p);
    res.json(rec);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

function frakaCodeSearchApi(req, res) {
  try {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: 'q is required' });
    res.json({ query: q, hits: codeReader.searchCode(q) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

// ── Autonomous coder — plan, write, QA, report ─────────────
async function frakaCoderBuildApi(req, res) {
  try {
    const { task, inlineFiles } = req.body || {};
    if (!task || typeof task !== 'string' || !task.trim()) {
      return res.status(400).json({ error: 'task is required' });
    }
    // Fire and forget so the caller doesn't wait on Sonnet + file ops
    coder.runCoderBuild(task.trim(), { inlineFiles: Array.isArray(inlineFiles) ? inlineFiles : [] })
      .then(record => logger.info(`[FRAKA-API] Build ${record.id} finished: ${record.status}`))
      .catch(err => logger.error(`[FRAKA-API] Build crashed: ${err.message}`));
    res.json({ success: true, message: 'Build started. Check Tech chat in 30-90 seconds for the full report.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function frakaCoderHistoryApi(req, res) {
  try {
    const limit = parseInt(req.query.limit, 10) || 30;
    res.json({ builds: coder.getBuildHistory(limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function frakaCoderBuildDetailApi(req, res) {
  try {
    const { id } = req.params;
    const build = coder.getBuild(id);
    if (!build) return res.status(404).json({ error: 'Build not found' });
    res.json(build);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── Developments — list ─────────────────────────────────────
function frakaDevelopmentsApi(req, res) {
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.priority) filter.priority = req.query.priority;
    const list = developmentsStore.listDevelopments(filter).map(d => ({
      ...d,
      daysUntilDue: developmentsStore.daysUntilDue(d),
    }));
    res.json({ developments: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── Developments — tech team action (approve/reject/in-progress/complete) ──
function frakaDevelopmentActionApi(req, res) {
  try {
    const { id } = req.params;
    const { action, approver, dueDays, reason } = req.body || {};
    if (!action) return res.status(400).json({ error: 'action required' });

    const dev = developmentsStore.getDevelopment(id);
    if (!dev) return res.status(404).json({ error: 'Development not found' });

    let updated;
    switch (action) {
      case 'approve':
        updated = developmentsStore.approveDevelopment(id, approver || 'tech', parseInt(dueDays, 10) || 7);
        break;
      case 'reject':
        updated = developmentsStore.rejectDevelopment(id, approver || 'tech', reason || '');
        break;
      case 'in-progress':
        updated = developmentsStore.setInProgress(id, approver || 'tech');
        break;
      case 'complete':
        updated = developmentsStore.markComplete(id, approver || 'tech');
        break;
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }

    logger.info(`[FRAKA-API] Development ${id} action=${action} by ${approver || 'tech'}`);
    res.json({
      success: true,
      development: { ...updated, daysUntilDue: developmentsStore.daysUntilDue(updated) },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── FRAKA Performance Dashboard ───────────────────────────
function frakaPerformanceApi(req, res) {
  try {
    const frakaState = readFrakaState();
    const builds = coder.getBuildHistory(100);
    const ceoHistory = conversationStore.loadHistory('ceo');
    const techHistory = conversationStore.loadHistory('tech');
    const allProposals = proposalsStore.listProposals({});
    const directives = ceoDirectives.getActiveDirectives();

    // Build stats
    const buildStats = { total: builds.length, success: 0, failed: 0, failedQa: 0, rolledBack: 0, noop: 0 };
    builds.forEach(b => {
      if (b.status === 'success') buildStats.success++;
      else if (b.status === 'failed') buildStats.failed++;
      else if (b.status === 'failed-qa') buildStats.failedQa++;
      else if (b.status === 'rolled-back') buildStats.rolledBack++;
      else if (b.status === 'noop') buildStats.noop++;
    });
    buildStats.successRate = buildStats.total > 0 ? Math.round((buildStats.success / buildStats.total) * 100) : 0;

    // Chat stats
    const ceoFrakaMsgs = ceoHistory.filter(m => m.sender === 'fraka');
    const techFrakaMsgs = techHistory.filter(m => m.sender === 'fraka');
    const chatStats = {
      ceoMessages: ceoHistory.length,
      ceoFrakaReplies: ceoFrakaMsgs.length,
      techMessages: techHistory.length,
      techFrakaReplies: techFrakaMsgs.length,
      totalReviews: frakaState.totalReviews || 0,
    };

    // Proposal stats
    const proposalStats = {
      total: allProposals.length,
      pending: allProposals.filter(p => p.status === 'pending').length,
      approved: allProposals.filter(p => p.status === 'approved').length,
      rejected: allProposals.filter(p => p.status === 'rejected').length,
    };

    // Activity timeline — last 30 FRAKA actions across all sources
    const timeline = [];

    // Add builds
    builds.slice(0, 20).forEach(b => {
      const icon = b.status === 'success' ? '✅' : b.status === 'noop' ? 'ℹ' : '❌';
      timeline.push({
        time: b.finishedAt || b.startedAt,
        type: 'build',
        icon,
        title: `Build ${b.status}: ${(b.task || '').slice(0, 80)}`,
        detail: b.status === 'success'
          ? `${(b.files || []).length} file(s) written and QA passed`
          : b.error || b.techNote || '',
        status: b.status,
      });
    });

    // Add reviews (from frakaState)
    if (frakaState.lastReviewAt) {
      timeline.push({
        time: frakaState.lastReviewAt,
        type: 'review',
        icon: '📊',
        title: 'Hourly Review',
        detail: (frakaState.lastReviewSummary || '').slice(0, 120),
        status: 'completed',
      });
    }

    // Add wake/sleep events from chat
    [...ceoHistory, ...techHistory]
      .filter(m => m.tag === 'wakeup' || m.tag === 'sleep')
      .slice(-10)
      .forEach(m => {
        timeline.push({
          time: m.timestamp,
          type: m.tag,
          icon: m.tag === 'wakeup' ? '☀' : '💤',
          title: m.tag === 'wakeup' ? 'FRAKA Woke Up' : 'FRAKA Went to Sleep',
          detail: '',
          status: 'completed',
        });
      });

    // Add directive captures
    directives.forEach(d => {
      timeline.push({
        time: d.capturedAt,
        type: 'directive',
        icon: '📜',
        title: `CEO Directive: ${d.directive.slice(0, 60)}`,
        detail: `[${d.priority}] ${d.category}`,
        status: 'active',
      });
    });

    // Sort by time desc
    timeline.sort((a, b) => new Date(b.time) - new Date(a.time));

    // Ongoing tasks — build-kickoff messages without a matching build completion
    const ongoingBuilds = [];
    const kickoffs = ceoHistory.concat(techHistory).filter(m => m.tag === 'build-kickoff');
    const completedBuildIds = new Set(builds.map(b => b.id));
    // Check recent kickoffs (last 5 min) that don't have a build result yet
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    kickoffs.filter(m => new Date(m.timestamp) > fiveMinAgo).forEach(m => {
      ongoingBuilds.push({
        time: m.timestamp,
        text: (m.text || '').slice(0, 120),
        status: 'in-progress',
      });
    });

    res.json({
      frakaActive: frakaState.active === true,
      awakenedAt: frakaState.awakenedAt || null,
      buildStats,
      chatStats,
      proposalStats,
      directivesCount: directives.length,
      timeline: timeline.slice(0, 30),
      ongoingBuilds,
    });
  } catch (err) {
    logger.error('[FRAKA-API] performance failed: ' + err.message);
    res.status(500).json({ error: err.message });
  }
}

// ── CEO Directives ────────────────────────────────────────
function frakaDirectivesListApi(req, res) {
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    else filter.status = 'active';
    if (req.query.category) filter.category = req.query.category;
    res.json({ directives: ceoDirectives.listDirectives(filter) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function frakaDirectivesAddApi(req, res) {
  try {
    const { directive, category, priority } = req.body || {};
    if (!directive || typeof directive !== 'string' || !directive.trim()) {
      return res.status(400).json({ error: 'directive text is required' });
    }
    const saved = ceoDirectives.addDirective(directive.trim(), {
      category: category || 'other',
      priority: priority || 'medium',
      capturedFrom: 'manual-dashboard',
    });
    res.json({ success: true, directive: saved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function frakaDirectivesUpdateApi(req, res) {
  try {
    const { id } = req.params;
    const patch = req.body || {};
    const allowed = ['directive', 'category', 'priority', 'status'];
    const clean = {};
    for (const k of allowed) if (patch[k] !== undefined) clean[k] = patch[k];
    const updated = ceoDirectives.updateDirective(id, clean);
    if (!updated) return res.status(404).json({ error: 'Directive not found' });
    res.json({ success: true, directive: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function frakaDirectivesDeleteApi(req, res) {
  try {
    const { id } = req.params;
    const removed = ceoDirectives.removeDirective(id);
    if (!removed) return res.status(404).json({ error: 'Directive not found' });
    res.json({ success: true, removed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  frakaStatusApi,
  frakaWakeApi,
  frakaSleepApi,
  frakaChatApi,
  frakaChatHistoryApi,
  frakaChatMessageActionApi,
  frakaChatClearApi,
  frakaProposalsApi,
  frakaApproveProposalApi,
  frakaRejectProposalApi,
  frakaReviewNowApi,
  frakaFeedbackApi,
  frakaFeedbackListApi,
  frakaPainPointsApi,
  frakaPainPointsRefreshApi,
  frakaDevelopmentsApi,
  frakaDevelopmentActionApi,
  frakaCodeTreeApi,
  frakaCodeListApi,
  frakaCodeReadApi,
  frakaCodeSearchApi,
  frakaCoderBuildApi,
  frakaCoderHistoryApi,
  frakaCoderBuildDetailApi,
  frakaDirectivesListApi,
  frakaDirectivesAddApi,
  frakaDirectivesUpdateApi,
  frakaDirectivesDeleteApi,
  frakaPerformanceApi,
};
