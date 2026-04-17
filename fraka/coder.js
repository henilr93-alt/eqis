// FRAKA Coder — autonomous build pipeline.
//
// Given a natural-language task ("add a Kolkata hotel scenario", "refactor
// searchPulse error handling", "fix the typing indicator spacing"), FRAKA:
//
//   1. PLANS       — asks Sonnet to decide which files to touch and what to write.
//   2. WRITES      — applies every file via codeReader.writeProjectFile (with auto-backup).
//   3. RUNS QA     — runs codeQA.runFileQA on each touched file.
//   4. ROLLS BACK  — if any QA check fails, restores files from their backups and marks the build FAILED.
//   5. REPORTS     — posts a detailed build report into the Tech chat and a short
//                    executive summary into the CEO chat.
//   6. LOGS        — persists the full build record in state/fraka/buildHistory.json.
//
// Safety posture:
//   - All writes go through codeReader's path guards + blocklist.
//   - Every write creates a timestamped backup under state/fraka/code-backups/.
//   - QA-failing builds are rolled back automatically.
//   - Max 8 files changed per cycle, max 500KB per file.
//   - FRAKA cannot touch .env, node_modules, .git, state/fraka/*.json, reports/, logs/.
//   - Every build is written to buildHistory.json for audit.

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const settings = require('../config/settings');
const { callClaude } = require('../utils/tokenOptimizer');
const { FRAKA_IDENTITY, FRAKA_RULES } = require('./systemPrompt');
const codeReader = require('./tools/codeReader');
const { runFileQA } = require('./tools/codeQA');
const conversationStore = require('./conversationStore');

const HISTORY_PATH = path.join(__dirname, '..', 'state', 'fraka', 'buildHistory.json');
const MAX_FILES_PER_CYCLE = 8;

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8')); } catch { return []; }
}
function saveHistory(list) {
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(list, null, 2));
}

function generateBuildId() {
  return 'BUILD-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

const CODER_SYSTEM_PROMPT = `${FRAKA_IDENTITY}

${FRAKA_RULES}

You are now in CODER mode. The tech team has delegated a concrete build task to
you. You will plan it, write the code, and send it back as a JSON plan. EQIS
will write the files, run active QA, roll back if anything fails, and report
the result to both chats.

You MUST return ONLY valid JSON matching this schema:

{
  "plan": "3-5 line summary of what you're going to do and why",
  "files": [
    {
      "filePath": "relative/path/from/project/root.js",
      "operation": "create" | "update" | "delete",
      "content": "<COMPLETE new file content — required for create and update>",
      "reason": "one-line why this file changes"
    }
  ],
  "followups": ["optional list of TODOs for tech team to do by hand"],
  "ceoNote": "1-sentence non-technical update for the CEO",
  "techNote": "2-4 sentence technical summary for the tech team"
}

Hard rules:
- Only touch files that exist in the EQIS project tree you were shown.
- Never touch .env, node_modules, .git, reports/, logs/, state/fraka/*.json.
- Max 8 files per cycle.
- For every update/create, the "content" field must be the COMPLETE file — not a diff.
- Match the existing coding style (Node.js CommonJS, 2-space indent, single quotes, terminal logging via "../utils/logger").
- Include inline comments so the tech team can review fast.
- If the task is ambiguous or unsafe, return an empty "files" array and explain in "plan".
- Produce no prose outside the JSON.`;

/**
 * Main entry point.
 * @param {string} task — natural-language description
 * @param {Object} [opts] — { inlineFiles?: string[], requester?: string }
 */
async function runCoderBuild(task, opts = {}) {
  const buildId = generateBuildId();
  const startedAt = new Date().toISOString();
  logger.info(`[FRAKA-CODER] ${buildId} task: "${task.slice(0, 140)}"`);

  // 1. Context — project tree + any explicitly-requested files
  const projectTree = codeReader.buildProjectTree({ maxDepth: 4 });
  const inlineFileChunks = [];
  if (Array.isArray(opts.inlineFiles)) {
    for (const f of opts.inlineFiles.slice(0, 8)) {
      try {
        const rec = codeReader.readProjectFile(f);
        inlineFileChunks.push(`--- ${rec.relPath} (${rec.lines} lines, ${rec.size}b) ---\n${rec.content}`);
      } catch (err) {
        inlineFileChunks.push(`--- COULD NOT READ ${f}: ${err.message} ---`);
      }
    }
  }

  // CEO directives block — coder must respect every standing order
  const ceoDirectives = require('./ceoDirectives');
  const directivesBlock = ceoDirectives.buildDirectivesBlock();

  const userPrompt = [
    directivesBlock,
    '=== BUILD TASK ===',
    task,
    '',
    '=== EQIS PROJECT TREE ===',
    projectTree,
    inlineFileChunks.length ? `\n=== FILES PULLED FOR CONTEXT ===\n${inlineFileChunks.join('\n\n')}` : '',
    '',
    'Now return the build plan JSON per the schema in the system prompt.',
    'Every file you plan must be consistent with the CEO directives listed above.',
  ].filter(Boolean).join('\n');

  // 2. Plan — ask Sonnet for a full build
  const planRaw = await callClaude({
    system: CODER_SYSTEM_PROMPT,
    userText: userPrompt,
    model: settings.FRAKA_ANALYSIS_MODEL,
    maxTokens: 8000,
    label: `fraka/coder/${buildId}`,
  });

  if (!planRaw) {
    const record = buildRecord(buildId, task, startedAt, 'failed', {
      error: 'No response from planner LLM',
    });
    persistBuild(record);
    return record;
  }

  let plan;
  try {
    plan = typeof planRaw === 'string' ? JSON.parse(planRaw) : planRaw;
  } catch (err) {
    logger.error(`[FRAKA-CODER] ${buildId} plan JSON parse failed: ${err.message}`);
    const record = buildRecord(buildId, task, startedAt, 'failed', {
      error: 'Plan JSON parse failed: ' + err.message,
      rawPlan: String(planRaw).slice(0, 2000),
    });
    persistBuild(record);
    return record;
  }

  if (!Array.isArray(plan.files) || plan.files.length === 0) {
    const record = buildRecord(buildId, task, startedAt, 'noop', {
      plan: plan.plan || '',
      ceoNote: plan.ceoNote || '',
      techNote: plan.techNote || 'FRAKA decided no code change was required for this task.',
      filesPlanned: 0,
    });
    persistBuild(record);
    postBuildReport(record);
    return record;
  }

  if (plan.files.length > MAX_FILES_PER_CYCLE) {
    plan.files = plan.files.slice(0, MAX_FILES_PER_CYCLE);
  }

  // 3. Write — every planned file goes through the safe writer
  const writeResults = [];
  const backups = [];
  let writeError = null;

  for (const f of plan.files) {
    try {
      const result = codeReader.writeProjectFile(
        f.filePath,
        f.content || '',
        (f.operation || 'update').toLowerCase()
      );
      writeResults.push({ ...f, ...result, ok: true });
      if (result.backup) backups.push({ relPath: result.relPath, backupName: result.backup });
    } catch (err) {
      writeError = { filePath: f.filePath, message: err.message };
      writeResults.push({ ...f, ok: false, error: err.message });
      break;
    }
  }

  if (writeError) {
    // Restore every successful write back from its backup
    const rollback = rollbackFromBackups(backups);
    const record = buildRecord(buildId, task, startedAt, 'rolled-back', {
      plan: plan.plan,
      files: writeResults,
      error: `Write failed: ${writeError.message}`,
      rollback,
      ceoNote: plan.ceoNote || 'FRAKA attempted a code change but rolled back after a write error.',
      techNote: `Write failed on ${writeError.filePath}: ${writeError.message}. All prior writes restored from backup.`,
    });
    persistBuild(record);
    postBuildReport(record);
    return record;
  }

  // 4. QA — run codeQA on every written file, roll back on any failure
  const qaResults = [];
  let qaFailed = false;
  for (const w of writeResults) {
    if (w.operation === 'delete') { qaResults.push({ relPath: w.relPath, ok: true, summary: 'deleted' }); continue; }
    const qa = runFileQA(w.relPath);
    qaResults.push({ relPath: w.relPath, ...qa });
    if (!qa.ok) qaFailed = true;
  }

  if (qaFailed) {
    const rollback = rollbackFromBackups(backups);
    // Also delete any freshly created files that had no backup to restore
    for (const w of writeResults) {
      if (w.ok && w.operation === 'create') {
        try {
          const abs = path.join(codeReader.PROJECT_ROOT, w.relPath);
          if (fs.existsSync(abs)) fs.unlinkSync(abs);
          rollback.push({ relPath: w.relPath, action: 'deleted-new-file' });
        } catch (e) { /* ignore */ }
      }
    }
    const record = buildRecord(buildId, task, startedAt, 'failed-qa', {
      plan: plan.plan,
      files: writeResults,
      qa: qaResults,
      rollback,
      ceoNote: plan.ceoNote || 'FRAKA attempted a code change but rolled back after active QA failed.',
      techNote: `QA failed on one or more files. Everything rolled back. Failed checks: ${qaResults.filter(q => !q.ok).map(q => q.relPath + ' (' + (q.summary || 'failed') + ')').join('; ')}.`,
    });
    persistBuild(record);
    postBuildReport(record);
    return record;
  }

  // 5. Success
  const record = buildRecord(buildId, task, startedAt, 'success', {
    plan: plan.plan,
    files: writeResults,
    qa: qaResults,
    followups: plan.followups || [],
    ceoNote: plan.ceoNote || 'FRAKA shipped a code change.',
    techNote: plan.techNote || `${writeResults.length} file(s) written and QA'd successfully.`,
  });
  persistBuild(record);
  postBuildReport(record);
  return record;
}

function rollbackFromBackups(backups) {
  const results = [];
  for (const { relPath, backupName } of backups) {
    try {
      const backupAbs = path.join(codeReader.PROJECT_ROOT, 'state', 'fraka', 'code-backups', backupName);
      const targetAbs = path.join(codeReader.PROJECT_ROOT, relPath);
      if (fs.existsSync(backupAbs)) {
        fs.copyFileSync(backupAbs, targetAbs);
        results.push({ relPath, action: 'restored', backup: backupName });
        logger.info(`[FRAKA-CODER] Rolled back ${relPath} from ${backupName}`);
      } else {
        results.push({ relPath, action: 'backup-missing' });
      }
    } catch (err) {
      results.push({ relPath, action: 'rollback-failed', message: err.message });
    }
  }
  return results;
}

function buildRecord(id, task, startedAt, status, extra = {}) {
  return {
    id,
    task,
    startedAt,
    finishedAt: new Date().toISOString(),
    status,
    ...extra,
  };
}

function persistBuild(record) {
  const list = loadHistory();
  list.push(record);
  // Trim to last 100 builds
  saveHistory(list.slice(-100));
}

/**
 * Post a build report to both CEO and Tech chats so both sides stay aligned.
 */
function postBuildReport(record) {
  const badge = {
    success: '✅ BUILD SUCCESS',
    'failed-qa': '⚠ BUILD ROLLED BACK (QA FAILED)',
    'rolled-back': '⚠ BUILD ROLLED BACK (WRITE FAILED)',
    failed: '❌ BUILD FAILED',
    noop: 'ℹ BUILD NO-OP',
  }[record.status] || '❔ BUILD';

  // Detailed tech report
  const fileLines = (record.files || []).map(f => {
    const tag = f.ok === false ? '❌' : f.operation === 'delete' ? '🗑' : f.operation === 'create' ? '🆕' : '✏';
    return `  ${tag} ${f.relPath || f.filePath} — ${f.operation}${f.backup ? ' (backup: ' + f.backup + ')' : ''}`;
  }).join('\n');

  const qaLines = (record.qa || []).map(q => {
    const tag = q.ok ? '✅' : '❌';
    return `  ${tag} ${q.relPath} — ${q.summary || (q.ok ? 'OK' : 'failed')}`;
  }).join('\n');

  const followups = (record.followups || []).length
    ? '\n\nFollow-ups:\n' + record.followups.map(t => '  • ' + t).join('\n')
    : '';

  const techText = [
    `${badge} — ${record.id}`,
    `Task: ${record.task}`,
    record.plan ? `Plan: ${record.plan}` : '',
    fileLines ? `\nFiles:\n${fileLines}` : '',
    qaLines ? `\nActive QA:\n${qaLines}` : '',
    record.error ? `\nError: ${record.error}` : '',
    (record.rollback && record.rollback.length) ? `\nRollback: ${record.rollback.map(r => r.relPath + ' → ' + r.action).join(', ')}` : '',
    record.techNote ? `\n${record.techNote}` : '',
    followups,
  ].filter(Boolean).join('\n');

  // Short CEO report (no code detail)
  const fileCount = (record.files || []).filter(f => f.ok !== false).length;
  const ceoText = [
    `${badge}`,
    `Task: ${record.task}`,
    record.ceoNote || '',
    record.status === 'success' ? `${fileCount} file${fileCount !== 1 ? 's' : ''} updated and QA-verified.` : '',
  ].filter(Boolean).join('\n');

  try {
    conversationStore.appendMessage('tech', { sender: 'fraka', text: techText, tag: 'build' });
    conversationStore.appendMessage('ceo', { sender: 'fraka', text: ceoText, tag: 'build' });
  } catch (err) {
    logger.error(`[FRAKA-CODER] Failed to post build report: ${err.message}`);
  }
}

function getBuildHistory(limit = 30) {
  return loadHistory().slice(-limit).reverse();
}

function getBuild(id) {
  return loadHistory().find(b => b.id === id) || null;
}

module.exports = { runCoderBuild, getBuildHistory, getBuild };
