// aiRoomJudge.js — AI fallback to decide whether two room+meal descriptions
// refer to the same logical product when our deterministic bucket matcher
// can't decide. Uses Claude (Haiku) for speed/cost.
//
// Usage:
//   const { judgeRoomPairs } = require('./aiRoomJudge');
//   const verdicts = await judgeRoomPairs([
//     { ecdRoom: 'Deluxe Garden View', ecdMeal: 'CP',
//       normalRoom: 'Superior Garden Room', normalMeal: 'Breakfast Included' },
//     ...
//   ]);
//   // verdicts: [{ match: true|false, confidence: 'high'|'med'|'low' }, ...]
//
// Cost safety:
//   - Batch all pairs into ONE Claude call per run (regardless of pair count up to 30).
//   - Use Haiku via FRAKA_CHAT_MODEL (cheapest model already configured).
//   - Cap pairs per call at 30 (if more, do additional batches).
//   - If Claude call fails or budget exhausted, fall back to "no match" (safe default).

const settings = require('../config/settings');
const logger = require('../utils/logger');
const { callClaude } = require('../utils/tokenOptimizer');
const ecdActivity = require('../utils/ecdActivity');

const MAX_PAIRS_PER_CALL = 30;

const SYSTEM_PROMPT =
  'You are a hotel room-category matching judge for a travel pricing comparison ' +
  'system. You are given pairs of room descriptions (each from a different supplier ' +
  'for the SAME hotel). For each pair, decide whether they describe the same logical ' +
  'room product — i.e. an agent could reasonably consider them equivalent when ' +
  'comparing prices. Treat differences in trivial phrasing (Deluxe vs Dlx, Garden ' +
  'View vs with Garden View, Twin vs 2 Twin Beds) as MATCH. Treat genuine product ' +
  'differences (Standard vs Deluxe, City View vs Sea View, Single vs Double bed, ' +
  'Standard vs Suite) as NO_MATCH. Also consider meal plans: Breakfast Included ' +
  'matches CP/BB/B&B; Room Only matches RO/EP/No Meals; Half Board matches MAP/HB. ' +
  'Reply with ONLY a JSON array, one object per input pair in order, like ' +
  '[{"i":0,"match":true,"conf":"high"},{"i":1,"match":false,"conf":"med"},...]. ' +
  'No prose, no markdown, no explanation. conf is one of: high, med, low.';

function buildUserPrompt(pairs) {
  const lines = ['Judge these room+meal pairs:'];
  pairs.forEach((p, i) => {
    lines.push(
      '[' + i + '] ECD: "' + (p.ecdRoom || '') + '" + meal "' + (p.ecdMeal || '') + '"  ' +
      'vs  Bedbank: "' + (p.normalRoom || '') + '" + meal "' + (p.normalMeal || '') + '"'
    );
  });
  lines.push('');
  lines.push('Return ONLY the JSON array. Items must appear in the same index order.');
  return lines.join('\n');
}

/**
 * Judge a batch of room+meal pairs.
 * @param {Array} pairs  array of {ecdRoom, ecdMeal, normalRoom, normalMeal}
 * @returns {Promise<Array<{match: boolean, confidence: string}>>}
 */
async function judgeRoomPairs(pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) return [];

  // Process in batches to avoid huge prompts
  const verdicts = new Array(pairs.length).fill(null);

  for (let start = 0; start < pairs.length; start += MAX_PAIRS_PER_CALL) {
    const batch = pairs.slice(start, start + MAX_PAIRS_PER_CALL);
    const userText = buildUserPrompt(batch);

    let response;
    try {
      response = await callClaude({
        system: SYSTEM_PROMPT,
        userText,
        mode: 'FAST',
        label: 'ecd-room-judge',
        // Use FRAKA_CHAT_MODEL (Haiku) for cheapest cost
        model: settings.FRAKA_CHAT_MODEL || settings.CLAUDE_MODEL,
        maxTokens: 800,
      });
    } catch (err) {
      logger.warn('[AI-JUDGE] Claude call failed: ' + err.message);
      // Fill batch with safe defaults
      for (let i = 0; i < batch.length; i++) {
        verdicts[start + i] = { match: false, confidence: 'low', reason: 'api-error' };
      }
      continue;
    }

    // callClaude returns parsed JSON when prompt asks for JSON (default behaviour).
    // So `response` should be the array we asked Claude to return.
    let parsed = response;
    if (!Array.isArray(parsed)) {
      // Maybe wrapped in {results:[...]} or similar — try common shapes
      if (parsed && Array.isArray(parsed.results)) parsed = parsed.results;
      else if (parsed && Array.isArray(parsed.verdicts)) parsed = parsed.verdicts;
      else parsed = null;
    }
    if (!parsed) {
      logger.warn('[AI-JUDGE] Could not interpret Claude reply as array — using safe defaults');
      for (let i = 0; i < batch.length; i++) {
        verdicts[start + i] = { match: false, confidence: 'low', reason: 'unexpected-shape' };
      }
      continue;
    }
    if (!parsed) {
      logger.warn('[AI-JUDGE] Could not parse Claude reply: ' + text.slice(0, 120));
      for (let i = 0; i < batch.length; i++) {
        verdicts[start + i] = { match: false, confidence: 'low', reason: 'parse-error' };
      }
      continue;
    }

    // Map parsed entries by index
    for (const entry of parsed) {
      const idx = typeof entry.i === 'number' ? entry.i : -1;
      if (idx < 0 || idx >= batch.length) continue;
      verdicts[start + idx] = {
        match: entry.match === true,
        confidence: entry.conf || 'med',
      };
    }

    // Any missing slots get safe defaults
    for (let i = 0; i < batch.length; i++) {
      if (!verdicts[start + i]) {
        verdicts[start + i] = { match: false, confidence: 'low', reason: 'missing-from-reply' };
      }
    }
  }

  const matched = verdicts.filter((v) => v.match).length;
  logger.info('[AI-JUDGE] ' + matched + '/' + verdicts.length + ' room pairs judged as match');
  return verdicts;
}

module.exports = { judgeRoomPairs };
