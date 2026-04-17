// FRAKA chat agent — handles a single message from CEO or Tech team.
// Uses Haiku for speed (chat) via tokenOptimizer.callClaude() with model override.

const settings = require('../config/settings');
const logger = require('../utils/logger');
const { callClaude } = require('../utils/tokenOptimizer');
const { FRAKA_CHAT_PROMPT } = require('./systemPrompt');
const conversationStore = require('./conversationStore');
const proposalsStore = require('./proposalsStore');

const { getSystemStatus } = require('./tools/systemStatus');
const { readMetrics } = require('./tools/readMetrics');
const { budgetCheck } = require('./tools/budgetCheck');
const { listProposals } = require('./tools/listProposals');
const { getRecentFeedback } = require('./tools/techFeedback');
const { buildProjectTree, readProjectFile } = require('./tools/codeReader');
const ceoDirectives = require('./ceoDirectives');
const { ZIPY_KNOWLEDGE } = require('./zipyKnowledge');

/**
 * Build a compact context blob to inject into the chat prompt.
 * Includes live status, last-hour metrics, budget, recent proposals, and tech feedback.
 */
function buildContextBlob(role) {
  const status = getSystemStatus();
  const metrics1h = readMetrics(1);
  const metrics24h = readMetrics(24);
  const budget = budgetCheck();
  const pendingProposals = listProposals({ status: 'pending' }).slice(0, 10);
  const feedback = role === 'tech' ? getRecentFeedback(10) : [];

  return {
    liveStatus: status,
    metricsLast1h: metrics1h,
    metricsLast24h: metrics24h,
    budget,
    pendingProposals: pendingProposals.map(p => ({
      id: p.id, type: p.type, description: p.description, audience: p.audience, createdAt: p.createdAt,
    })),
    techFeedback: feedback,
    role,
  };
}

/**
 * Parse a FRAKA reply for an optional <PROPOSALS>...</PROPOSALS> block.
 * Returns { cleanReply, proposals }.
 */
function extractProposals(rawReply) {
  if (!rawReply || typeof rawReply !== 'string') return { cleanReply: '', proposals: [] };
  const match = rawReply.match(/<PROPOSALS>([\s\S]*?)<\/PROPOSALS>/);
  if (!match) return { cleanReply: rawReply.trim(), proposals: [] };

  let proposals = [];
  try {
    // Trim any markdown code fence inside the block
    let inner = match[1].trim();
    inner = inner.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    proposals = JSON.parse(inner);
    if (!Array.isArray(proposals)) proposals = [proposals];
  } catch (err) {
    logger.warn(`[FRAKA] Failed to parse <PROPOSALS> block: ${err.message}`);
    proposals = [];
  }

  const cleanReply = rawReply.replace(/<PROPOSALS>[\s\S]*?<\/PROPOSALS>/, '').trim();
  return { cleanReply, proposals };
}

/**
 * Parse a FRAKA reply for an optional <DIRECTIVE>...</DIRECTIVE> block.
 * Returns { cleanReply, directives[] }.
 */
function extractCeoDirectives(rawReply) {
  if (!rawReply || typeof rawReply !== 'string') return { cleanReply: rawReply || '', directives: [] };
  const match = rawReply.match(/<DIRECTIVE>([\s\S]*?)<\/DIRECTIVE>/);
  if (!match) return { cleanReply: rawReply, directives: [] };

  let directives = [];
  try {
    let inner = match[1].trim();
    inner = inner.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    const parsed = JSON.parse(inner);
    directives = Array.isArray(parsed) ? parsed : [parsed];
  } catch (err) {
    logger.warn(`[FRAKA] Failed to parse <DIRECTIVE> block: ${err.message}`);
    directives = [];
  }

  const cleanReply = rawReply.replace(/<DIRECTIVE>[\s\S]*?<\/DIRECTIVE>/, '').trim();
  return { cleanReply, directives };
}

/**
 * Parse a FRAKA reply for an optional <BUILD>...</BUILD> directive.
 * Returns { cleanReply, buildTask }.
 */
function extractBuildDirective(rawReply) {
  if (!rawReply || typeof rawReply !== 'string') return { cleanReply: rawReply || '', buildTask: null };
  const match = rawReply.match(/<BUILD>([\s\S]*?)<\/BUILD>/);
  if (!match) return { cleanReply: rawReply, buildTask: null };

  let buildTask = null;
  try {
    let inner = match[1].trim();
    inner = inner.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    buildTask = JSON.parse(inner);
    if (typeof buildTask === 'string') buildTask = { task: buildTask };
  } catch (err) {
    logger.warn(`[FRAKA] Failed to parse <BUILD> block: ${err.message}`);
    buildTask = null;
  }

  const cleanReply = rawReply.replace(/<BUILD>[\s\S]*?<\/BUILD>/, '').trim();
  return { cleanReply, buildTask };
}

/**
 * Main chat entry point.
 * @param {string} role - 'ceo' | 'tech'
 * @param {string} message - the user's message
 * @param {Object} [replyTo] - optional reply context {id, sender, textExcerpt}
 * @returns {Promise<Object>} { reply, newProposals, tokenUsage }
 */
async function handleChatMessage(role, message, replyTo = null) {
  if (!conversationStore.VALID_ROLES.includes(role)) {
    throw new Error(`Invalid role: ${role}`);
  }
  if (!message || typeof message !== 'string') {
    throw new Error('Message is required');
  }

  logger.info(`[FRAKA] Chat message from ${role}: "${message.slice(0, 80)}${message.length > 80 ? '...' : ''}"${replyTo ? ' [reply-to: ' + replyTo.id + ']' : ''}`);

  // Append user message to history immediately (with optional replyTo)
  conversationStore.appendMessage(role, { sender: 'user', text: message, replyTo });

  // If FRAKA is sleeping, reply with a wake-up prompt and skip all Claude calls
  const { isFrakaAwake } = require('./reviewer');
  if (!isFrakaAwake()) {
    const sleepReply = '💤 I am currently sleeping. Click **"Wake Up FRAKA"** in the dashboard to wake me up — I will resume all EQIS engines and start analyzing again.';
    conversationStore.appendMessage(role, { sender: 'fraka', text: sleepReply, tag: 'asleep' });
    return { reply: sleepReply, newProposals: [], asleep: true };
  }

  // Build compact context
  const context = buildContextBlob(role);
  const contextJson = JSON.stringify(context, null, 2);

  // Project file tree (only for tech role — CEO doesn't need the code dump)
  let projectTree = '';
  let inlineFiles = '';
  if (role === 'tech') {
    try { projectTree = buildProjectTree({ maxDepth: 3 }); } catch (e) { projectTree = ''; }

    // Parse @file mentions from the message — lets users pull specific files into context.
    // Syntax: @file:path/to/file.js (multiple allowed)
    const fileMentions = [...new Set((message.match(/@file:([^\s]+)/g) || [])
      .map(t => t.replace('@file:', ''))
      .slice(0, 5))];
    if (fileMentions.length > 0) {
      const chunks = [];
      for (const f of fileMentions) {
        try {
          const rec = readProjectFile(f);
          chunks.push(`--- BEGIN FILE: ${rec.relPath} (${rec.lines} lines, ${rec.size}b) ---\n${rec.content}\n--- END FILE: ${rec.relPath} ---`);
        } catch (err) {
          chunks.push(`--- COULD NOT READ ${f}: ${err.message} ---`);
        }
      }
      inlineFiles = chunks.join('\n\n');
    }
  }

  // Load recent chat history (last 8 messages) for short-term memory
  const history = conversationStore.getRecentMessages(role, 8);
  const historyText = history
    .slice(0, -1) // exclude the message we just appended
    .map(m => `${m.sender === 'user' ? 'USER' : 'FRAKA'}: ${m.text}`)
    .join('\n');

  // Reply-to block for the prompt — tells FRAKA exactly what the user is quoting
  const replyBlock = replyTo && replyTo.textExcerpt
    ? `=== THE USER IS REPLYING TO THIS EARLIER MESSAGE ===\nFrom: ${replyTo.sender === 'user' ? 'USER (themselves)' : 'FRAKA (you, earlier)'}\nQuoted text: "${replyTo.textExcerpt}"\n`
    : '';

  // CEO directives block — ALWAYS first in the prompt so Haiku sees them
  // before anything else. These are standing orders FRAKA must obey.
  const directivesBlock = ceoDirectives.buildDirectivesBlock();

  const userPrompt = [
    directivesBlock,
    '',
    `ROLE: ${role.toUpperCase()}`,
    '',
    '=== LIVE CONTEXT ===',
    contextJson,
    '',
    projectTree ? `=== EQIS PROJECT TREE (paths FRAKA can read/write via code_change proposals) ===\n${projectTree}\n` : '',
    inlineFiles ? `=== INLINE FILE CONTENTS (pulled via @file: mentions) ===\n${inlineFiles}\n` : '',
    historyText ? `=== RECENT CHAT ===\n${historyText}\n` : '',
    replyBlock,
    '=== CURRENT MESSAGE ===',
    message,
  ].filter(Boolean).join('\n');

  // Call Haiku for fast chat response — inject Zipy knowledge into system prompt
  const systemPromptWithZipy = FRAKA_CHAT_PROMPT + '\n\n' + ZIPY_KNOWLEDGE;
  const reply = await callClaude({
    system: systemPromptWithZipy,
    userText: userPrompt,
    model: settings.FRAKA_CHAT_MODEL,
    maxTokens: 800,
    rawText: true,
    label: `fraka/chat/${role}`,
  });

  if (!reply) {
    const errMsg = 'I was unable to process that. Please try again or check the logs.';
    conversationStore.appendMessage(role, { sender: 'fraka', text: errMsg });
    return { reply: errMsg, newProposals: [], error: 'claude_api_failed' };
  }

  // Extract, in order: CEO directives → proposals → BUILD directive
  const afterDirectives = extractCeoDirectives(reply);
  const afterProposals = extractProposals(afterDirectives.cleanReply);
  const { cleanReply: afterBuildReply, buildTask } = extractBuildDirective(afterProposals.cleanReply);
  const proposals = afterProposals.proposals;
  const cleanReply = afterBuildReply;

  // Persist CEO directives — ONLY captured from CEO-role messages.
  const capturedDirectives = [];
  if (role === 'ceo') {
    for (const d of afterDirectives.directives) {
      if (!d || typeof d.directive !== 'string') continue;
      const saved = ceoDirectives.addDirective(d.directive, {
        category: d.category || 'other',
        priority: d.priority || 'medium',
        capturedFrom: 'ceo-chat',
      });
      if (saved) capturedDirectives.push(saved);
    }
  }

  // Persist proposals to store
  const newProposals = [];
  for (const p of proposals) {
    try {
      const saved = proposalsStore.createProposal(p, `fraka-chat-${role}`);
      newProposals.push(saved);
    } catch (err) {
      logger.error(`[FRAKA] Failed to save proposal: ${err.message}`);
    }
  }

  // Fire the autonomous coder pipeline if a <BUILD> directive was emitted
  if (buildTask && buildTask.task) {
    logger.info(`[FRAKA] BUILD directive from ${role}: "${buildTask.task.slice(0, 120)}"`);
    // Lazy-require to avoid a circular dependency at load time
    const coder = require('./coder');
    coder.runCoderBuild(buildTask.task, { inlineFiles: Array.isArray(buildTask.inlineFiles) ? buildTask.inlineFiles : [] })
      .then(record => logger.info(`[FRAKA] BUILD ${record.id} finished: ${record.status}`))
      .catch(err => logger.error(`[FRAKA] BUILD crashed: ${err.message}`));
  }

  // Append FRAKA's reply to history
  conversationStore.appendMessage(role, {
    sender: 'fraka',
    text: cleanReply || (buildTask ? 'On it. Build pipeline started — check Tech chat for the report in ~60 seconds.' : '(no reply)'),
    proposals: newProposals.map(p => p.id),
    tag: buildTask ? 'build-kickoff' : null,
  });

  return { reply: cleanReply, newProposals, buildTask, capturedDirectives };
}

module.exports = { handleChatMessage, buildContextBlob, extractProposals, extractBuildDirective, extractCeoDirectives };
