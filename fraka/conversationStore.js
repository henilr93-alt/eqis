// Per-role chat history persistence.
// Writes to state/fraka/chats/{ceo,tech}.json as an append-only array.
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const CHATS_DIR = path.join(__dirname, '..', 'state', 'fraka', 'chats');

const VALID_ROLES = ['ceo', 'tech'];

function chatFile(role) {
  if (!VALID_ROLES.includes(role)) {
    throw new Error(`Invalid role: ${role}. Must be one of ${VALID_ROLES.join(', ')}`);
  }
  return path.join(CHATS_DIR, `${role}.json`);
}

function generateMessageId() {
  return 'msg-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

function loadHistory(role) {
  try {
    const list = JSON.parse(fs.readFileSync(chatFile(role), 'utf-8'));
    // Backfill ids for legacy messages without one
    let mutated = false;
    list.forEach(m => {
      if (!m.id) { m.id = generateMessageId(); mutated = true; }
    });
    if (mutated) {
      try { saveHistory(role, list); } catch { /* ignore */ }
    }
    return list;
  } catch { return []; }
}

function saveHistory(role, messages) {
  fs.writeFileSync(chatFile(role), JSON.stringify(messages, null, 2));
}

/**
 * Append a single message to a role's chat history.
 * @param {string} role - 'ceo' | 'tech'
 * @param {Object} msg - {sender: 'user'|'fraka', text, timestamp?, tag?, proposals?, replyTo?}
 */
function appendMessage(role, msg) {
  const list = loadHistory(role);
  const entry = {
    id: msg.id || generateMessageId(),
    sender: msg.sender,
    text: msg.text,
    timestamp: msg.timestamp || new Date().toISOString(),
    tag: msg.tag || null,          // e.g. 'review' | 'alert' | null
    proposals: msg.proposals || [], // Array of proposal IDs referenced in this message
    replyTo: msg.replyTo || null,  // {id, sender, textExcerpt} if this is a reply
  };
  list.push(entry);
  // Trim to last 500 messages to prevent unbounded growth
  const trimmed = list.slice(-500);
  saveHistory(role, trimmed);
  return entry;
}

function getRecentMessages(role, count = 10) {
  const list = loadHistory(role);
  return list.slice(-count);
}

function clearHistory(role) {
  saveHistory(role, []);
  logger.info(`[FRAKA] Cleared chat history for ${role}`);
}

/**
 * Apply a patch to a specific message by id.
 * Patch fields supported: text, edited, deleted, starred, pinned, reactions
 */
function updateMessage(role, messageId, patch) {
  const list = loadHistory(role);
  const idx = list.findIndex(m => m.id === messageId);
  if (idx === -1) return null;
  const existing = list[idx];
  const updated = { ...existing };

  if (patch.text !== undefined) {
    updated.text = String(patch.text);
    updated.edited = true;
    updated.editedAt = new Date().toISOString();
  }
  if (patch.deleted === true) {
    updated.deleted = true;
    updated.text = '🚫 This message was deleted';
    updated.reactions = [];
  }
  if (patch.starred !== undefined) updated.starred = !!patch.starred;
  if (patch.pinned !== undefined) updated.pinned = !!patch.pinned;
  if (Array.isArray(patch.reactions)) updated.reactions = patch.reactions;

  list[idx] = updated;
  saveHistory(role, list);
  return updated;
}

function toggleReaction(role, messageId, emoji, actor = 'user') {
  const list = loadHistory(role);
  const idx = list.findIndex(m => m.id === messageId);
  if (idx === -1) return null;
  const msg = list[idx];
  const reactions = Array.isArray(msg.reactions) ? msg.reactions.slice() : [];

  // Find existing reaction from this actor
  const existing = reactions.findIndex(r => r.actor === actor && r.emoji === emoji);
  if (existing !== -1) {
    reactions.splice(existing, 1); // toggle off
  } else {
    // Remove any other reaction from same actor (one reaction per actor — WhatsApp behavior)
    const other = reactions.findIndex(r => r.actor === actor);
    if (other !== -1) reactions.splice(other, 1);
    reactions.push({ emoji, actor, at: new Date().toISOString() });
  }
  msg.reactions = reactions;
  list[idx] = msg;
  saveHistory(role, list);
  return msg;
}

function getPinnedMessages(role) {
  return loadHistory(role).filter(m => m.pinned && !m.deleted);
}

module.exports = {
  loadHistory,
  appendMessage,
  getRecentMessages,
  clearHistory,
  updateMessage,
  toggleReaction,
  getPinnedMessages,
  generateMessageId,
  VALID_ROLES,
};
