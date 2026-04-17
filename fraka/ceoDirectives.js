// CEO Directives — persistent memory of every rule, guideline, preference,
// or instruction the CEO gives FRAKA. Injected into every FRAKA prompt so
// FRAKA treats them as hard overrides of default behaviour.
//
// Stored in state/fraka/ceoDirectives.json as an array of:
//   { id, directive, category, priority, capturedAt, capturedFromMessageId,
//     status: 'active'|'archived', updatedAt }
//
// Categories: scope | budget | schedule | reporting | safety | preference | other
// Priorities:  critical | high | medium | low

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const STORE_PATH = path.join(__dirname, '..', 'state', 'fraka', 'ceoDirectives.json');

function loadStore() {
  try { return JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8')); }
  catch { return []; }
}

function saveStore(list) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(list, null, 2));
}

function generateId() {
  return 'DIR-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

/**
 * Add a new directive. Dedupes on exact text match.
 */
function addDirective(directive, opts = {}) {
  if (!directive || typeof directive !== 'string' || !directive.trim()) {
    return null;
  }
  const text = directive.trim();
  const list = loadStore();

  // Dedupe — if the same directive text already exists and is active, skip.
  const existing = list.find(d => d.directive.toLowerCase() === text.toLowerCase() && d.status === 'active');
  if (existing) {
    logger.info(`[FRAKA-DIR] Dedupe hit for "${text.slice(0, 60)}" — keeping existing ${existing.id}`);
    return existing;
  }

  const now = new Date().toISOString();
  const entry = {
    id: generateId(),
    directive: text,
    category: opts.category || 'other',
    priority: opts.priority || 'medium',
    capturedAt: now,
    capturedFromMessageId: opts.capturedFromMessageId || null,
    capturedFrom: opts.capturedFrom || 'ceo-chat',
    status: 'active',
    updatedAt: now,
  };
  list.push(entry);
  saveStore(list);
  logger.info(`[FRAKA-DIR] ✚ New CEO directive captured: ${entry.id} [${entry.priority}] "${text.slice(0, 80)}"`);
  return entry;
}

function listDirectives(filter = {}) {
  let list = loadStore();
  if (filter.status) list = list.filter(d => d.status === filter.status);
  if (filter.category) list = list.filter(d => d.category === filter.category);
  // Sort by priority (critical > high > medium > low), then by recency
  const rank = { critical: 0, high: 1, medium: 2, low: 3 };
  list.sort((a, b) => {
    const r = (rank[a.priority] ?? 9) - (rank[b.priority] ?? 9);
    if (r !== 0) return r;
    return new Date(b.capturedAt) - new Date(a.capturedAt);
  });
  return list;
}

function getActiveDirectives() {
  return listDirectives({ status: 'active' });
}

function updateDirective(id, patch) {
  const list = loadStore();
  const idx = list.findIndex(d => d.id === id);
  if (idx === -1) return null;
  list[idx] = { ...list[idx], ...patch, updatedAt: new Date().toISOString() };
  saveStore(list);
  return list[idx];
}

function removeDirective(id) {
  const list = loadStore();
  const idx = list.findIndex(d => d.id === id);
  if (idx === -1) return null;
  const removed = list[idx];
  list.splice(idx, 1);
  saveStore(list);
  logger.info(`[FRAKA-DIR] ✕ Removed directive ${id}`);
  return removed;
}

function archiveDirective(id) {
  return updateDirective(id, { status: 'archived' });
}

/**
 * Build a compact string block of all active directives to inject into FRAKA prompts.
 * Kept under ~3KB to avoid bloating token count.
 */
function buildDirectivesBlock() {
  const active = getActiveDirectives();
  if (active.length === 0) return '';
  const lines = active.slice(0, 40).map((d, i) => {
    const pri = d.priority.toUpperCase();
    const cat = d.category;
    return `  ${i + 1}. [${pri}][${cat}] ${d.directive}`;
  });
  return [
    '=== CEO DIRECTIVES — HARD RULES (OBEY ABOVE ALL DEFAULTS) ===',
    'The CEO has given you these standing orders. You MUST obey every single one',
    'on every turn, in every review, in every build. Violating any directive is',
    'a critical failure. If two directives conflict, honour the higher priority.',
    '',
    ...lines,
    '',
    '=== END CEO DIRECTIVES ===',
  ].join('\n');
}

module.exports = {
  addDirective,
  listDirectives,
  getActiveDirectives,
  updateDirective,
  removeDirective,
  archiveDirective,
  buildDirectivesBlock,
};
