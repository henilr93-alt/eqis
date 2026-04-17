// Developments store — persistent CRUD for enhancement ideas.
// Each development = a user-journey improvement suggestion from Zipy/FRAKA analysis.
// Tech team can approve, reject, or mark in-progress; CEO views only.
// Due days are set on approval and decrement daily.

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const DEVS_PATH = path.join(__dirname, '..', 'state', 'fraka', 'developments.json');

function loadStore() {
  try { return JSON.parse(fs.readFileSync(DEVS_PATH, 'utf-8')); }
  catch { return { developments: [] }; }
}

function saveStore(store) {
  fs.writeFileSync(DEVS_PATH, JSON.stringify(store, null, 2));
}

function nextId() {
  return 'DEV-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

// Fingerprint for dedup — so the same idea isn't re-created on every analysis refresh
function fingerprint(dev) {
  const norm = s => (s || '').toString().toLowerCase().replace(/\s+/g, ' ').trim();
  return `${norm(dev.category)}|${norm(dev.subcategory)}|${norm(dev.title)}`;
}

/**
 * Create or update a development from analyzer output.
 * Uses fingerprint-based dedup so re-runs don't create duplicates.
 * @returns {Object} the stored development record
 */
function upsertDevelopment(dev, source = 'fraka-analysis') {
  const store = loadStore();
  const fp = fingerprint(dev);
  const existing = store.developments.find(d => d._fp === fp);

  if (existing) {
    // Update occurrence count + last-analyzed timestamp, preserve approval state
    existing.lastAnalyzedAt = new Date().toISOString();
    existing.occurrences = (existing.occurrences || 0) + 1;
    // Refresh data that may change: customerBenefit, effort, priority, evidence
    if (dev.customerBenefit) existing.customerBenefit = dev.customerBenefit;
    if (dev.evidence) existing.evidence = dev.evidence;
    if (dev.priority) existing.priority = dev.priority;
    if (dev.effort) existing.effort = dev.effort;
    saveStore(store);
    return existing;
  }

  const record = {
    id: nextId(),
    _fp: fp,
    category: dev.category || 'User Journey',
    subcategory: dev.subcategory || '',
    title: dev.title || '',
    description: dev.description || dev.title || '',
    customerBenefit: dev.customerBenefit || '',
    evidence: dev.evidence || '',
    priority: dev.priority || 'MEDIUM',       // HIGH | MEDIUM | LOW
    effort: dev.effort || 'M',                // S | M | L | XL
    source,                                    // 'fraka-analysis' | 'zipy-<date>' | 'tech-feedback'
    techApprovalStatus: 'pending',             // pending | approved | rejected | in-progress | completed
    techApprovedBy: null,
    techApprovedAt: null,
    rejectionReason: null,
    dueDate: null,
    dueDays: null,
    occurrences: 1,
    createdAt: new Date().toISOString(),
    lastAnalyzedAt: new Date().toISOString(),
  };
  store.developments.push(record);
  saveStore(store);
  logger.info(`[FRAKA] Development created: ${record.id} — ${record.title.slice(0, 60)}`);
  return record;
}

function listDevelopments(filter = {}) {
  let list = loadStore().developments;
  if (filter.status) list = list.filter(d => d.techApprovalStatus === filter.status);
  if (filter.priority) list = list.filter(d => d.priority === filter.priority);
  // Sort: pending first, then approved by due date, then rejected/completed
  const rank = { pending: 0, approved: 1, 'in-progress': 2, completed: 3, rejected: 4 };
  list = list.slice().sort((a, b) => {
    const ra = rank[a.techApprovalStatus] ?? 9;
    const rb = rank[b.techApprovalStatus] ?? 9;
    if (ra !== rb) return ra - rb;
    // Then by priority HIGH > MEDIUM > LOW
    const pr = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    const pa = pr[a.priority] ?? 9;
    const pb = pr[b.priority] ?? 9;
    if (pa !== pb) return pa - pb;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });
  return list;
}

function getDevelopment(id) {
  return loadStore().developments.find(d => d.id === id) || null;
}

function updateDevelopment(id, updates) {
  const store = loadStore();
  const idx = store.developments.findIndex(d => d.id === id);
  if (idx === -1) return null;
  store.developments[idx] = { ...store.developments[idx], ...updates };
  saveStore(store);
  return store.developments[idx];
}

/**
 * Tech team approves a development and sets a due date.
 */
function approveDevelopment(id, approver, dueDays = 7) {
  const now = new Date();
  const dueDate = new Date(now.getTime() + dueDays * 86400 * 1000).toISOString();
  return updateDevelopment(id, {
    techApprovalStatus: 'approved',
    techApprovedBy: approver,
    techApprovedAt: now.toISOString(),
    dueDate,
    dueDays,
    rejectionReason: null,
  });
}

function rejectDevelopment(id, rejector, reason = '') {
  return updateDevelopment(id, {
    techApprovalStatus: 'rejected',
    techApprovedBy: rejector,
    techApprovedAt: new Date().toISOString(),
    rejectionReason: reason,
  });
}

function setInProgress(id, user) {
  return updateDevelopment(id, {
    techApprovalStatus: 'in-progress',
    techApprovedBy: user,
  });
}

function markComplete(id, user) {
  return updateDevelopment(id, {
    techApprovalStatus: 'completed',
    techApprovedBy: user,
    completedAt: new Date().toISOString(),
  });
}

/**
 * Compute days remaining until due date. Negative = overdue.
 */
function daysUntilDue(development) {
  if (!development || !development.dueDate) return null;
  const now = new Date();
  const due = new Date(development.dueDate);
  const ms = due - now;
  return Math.round(ms / (86400 * 1000) * 10) / 10;
}

module.exports = {
  upsertDevelopment,
  listDevelopments,
  getDevelopment,
  updateDevelopment,
  approveDevelopment,
  rejectDevelopment,
  setInProgress,
  markComplete,
  daysUntilDue,
};
