const Anthropic = require('@anthropic-ai/sdk');
const settings = require('../config/settings');
const logger = require('./logger');
const { getLocalDateString } = require('./timezone');

const client = new Anthropic({ apiKey: settings.ANTHROPIC_API_KEY });

// ── Token budgets per mode ────────────────────────────────────
const MODES = {
  FAST: { maxTokens: 200, model: settings.CLAUDE_MODEL },
  STANDARD: { maxTokens: 600, model: settings.CLAUDE_MODEL },
  DEEP: { maxTokens: 1200, model: settings.CLAUDE_MODEL },
};

// ── Session-level counter ─────────────────────────────────────
let sessionTokens = { input: 0, output: 0, calls: 0 };
let sessionEvalModes = { fast: 0, standard: 0, deep: 0 };

function resetSessionTokens() {
  sessionTokens = { input: 0, output: 0, calls: 0 };
  sessionEvalModes = { fast: 0, standard: 0, deep: 0 };
}

function trackEvalMode(mode) {
  const key = (mode || '').toLowerCase();
  if (key in sessionEvalModes) sessionEvalModes[key]++;
}

function getSessionEvalModes() {
  return { ...sessionEvalModes };
}

function getSessionTokens() {
  return {
    input: sessionTokens.input,
    output: sessionTokens.output,
    calls: sessionTokens.calls,
    total: sessionTokens.input + sessionTokens.output,
  };
}

// ── Daily budget guard ────────────────────────────────────────
const DAILY_TOKEN_CAP = 2_000_000;
let dailyTokens = 0;
let dailyResetDate = getLocalDateString();

function checkDailyBudget() {
  const today = getLocalDateString();
  if (today !== dailyResetDate) {
    dailyTokens = 0;
    dailyResetDate = today;
    logger.info('[TOKENS] Daily counter reset');
  }
  if (dailyTokens >= DAILY_TOKEN_CAP) {
    logger.error(`[TOKENS] Daily cap reached: ${dailyTokens.toLocaleString()} tokens. Skipping API call.`);
    return false;
  }
  return true;
}

// ── Mode selector ─────────────────────────────────────────────
function selectMode(context) {
  const {
    isMirrorScenario = false,
    stepStatus = 'unknown',
    hasBugs = false,
    engineType = 'journey',
    stepName = '',
  } = context;

  if (engineType === 'zipy') return 'DEEP';
  if (isMirrorScenario) return 'DEEP';
  if (['bugAggregation', 'trendExtraction', 'sessionAnalysis'].includes(stepName)) return 'DEEP';
  if (engineType === 'searchpulse' && stepStatus === 'healthy') return 'FAST';
  if (['login', 'flightAddons'].includes(stepName) && !hasBugs) return 'FAST';
  if (stepName.includes('payment') || stepName.includes('Payment')) return 'DEEP';
  return 'STANDARD';
}

// ── Main API call wrapper ─────────────────────────────────────
// Optional params:
//   model       — override the default model for this call (e.g. Haiku for FRAKA chat)
//   maxTokens   — override the mode's default max_tokens
//   rawText     — if true, return the raw text string instead of parsing JSON
//   messages    — if provided, override the default single-user-message shape
async function callClaude({
  system, userText, imageBase64,
  mode = 'STANDARD', label = '',
  model: modelOverride,
  maxTokens: maxTokensOverride,
  rawText = false,
  messages: messagesOverride,
}) {
  if (!checkDailyBudget()) return null;

  const { maxTokens: defaultMax, model: defaultModel } = MODES[mode] || MODES.STANDARD;
  const model = modelOverride || defaultModel;
  const maxTokens = maxTokensOverride || defaultMax;

  let messages;
  if (messagesOverride) {
    messages = messagesOverride;
  } else {
    const content = [];
    if (imageBase64) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: imageBase64 },
      });
    }
    if (userText) {
      content.push({ type: 'text', text: userText });
    }
    messages = [{ role: 'user', content }];
  }

  const trimmedSystem = trimPrompt(system);

  // Track eval mode for metrics
  trackEvalMode(mode);

  try {
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: trimmedSystem,
      messages,
    });

    const usage = response.usage || {};
    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    sessionTokens.input += inputTokens;
    sessionTokens.output += outputTokens;
    sessionTokens.calls += 1;
    dailyTokens += inputTokens + outputTokens;

    logger.info(`[TOKENS] ${label} | mode:${mode} | model:${model.split('-').slice(1, 3).join('-')} | in:${inputTokens} out:${outputTokens} | session total: ${sessionTokens.input + sessionTokens.output}`);

    const raw = response.content.find(b => b.type === 'text')?.text || '';
    if (rawText) return raw;
    return safeParseJson(raw, label);
  } catch (err) {
    logger.error(`[TOKENS] API call failed: ${label} — ${err.message}`);
    return null;
  }
}

// ── Prompt trimmer ────────────────────────────────────────────
function trimPrompt(text) {
  if (!text) return '';
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// ── Safe JSON parser ──────────────────────────────────────────
function safeParseJson(raw, label) {
  try {
    const clean = raw
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();
    return JSON.parse(clean);
  } catch (err) {
    logger.warn(`[TOKENS] JSON parse failed for ${label} — returning null`);
    return null;
  }
}

module.exports = {
  callClaude,
  selectMode,
  resetSessionTokens,
  getSessionTokens,
  getSessionEvalModes,
  trackEvalMode,
  checkDailyBudget,
};
