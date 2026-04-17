// Proposal CRUD — writes to state/fraka/proposals.json
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const PROPOSALS_PATH = path.join(__dirname, '..', 'state', 'fraka', 'proposals.json');

function loadProposals() {
  try {
    return JSON.parse(fs.readFileSync(PROPOSALS_PATH, 'utf-8'));
  } catch { return []; }
}

function saveProposals(list) {
  fs.writeFileSync(PROPOSALS_PATH, JSON.stringify(list, null, 2));
}

function nextId() {
  return 'PROP-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

/**
 * Create a new proposal. Returns the full proposal object.
 * @param {Object} proposal - {type, description, details, audience, reasoning, estimatedCostImpactUsd}
 * @param {string} createdBy - 'fraka' | 'review'
 */
function createProposal(proposal, createdBy = 'fraka') {
  const list = loadProposals();
  const p = {
    id: nextId(),
    type: proposal.type,
    description: proposal.description || '',
    details: proposal.details || {},
    audience: proposal.audience || 'tech',
    reasoning: proposal.reasoning || '',
    estimatedCostImpactUsd: proposal.estimatedCostImpactUsd || 0,
    status: 'pending',
    createdBy,
    createdAt: new Date().toISOString(),
    approvedAt: null,
    approvedBy: null,
    rejectedAt: null,
    executionResult: null,
  };
  list.push(p);
  saveProposals(list);
  logger.info(`[FRAKA] Proposal created: ${p.id} [${p.type}] for ${p.audience}`);
  return p;
}

function getProposal(id) {
  return loadProposals().find(p => p.id === id) || null;
}

function updateProposal(id, updates) {
  const list = loadProposals();
  const idx = list.findIndex(p => p.id === id);
  if (idx === -1) return null;
  list[idx] = { ...list[idx], ...updates };
  saveProposals(list);
  return list[idx];
}

function listProposals(filter = {}) {
  let list = loadProposals();
  if (filter.status) list = list.filter(p => p.status === filter.status);
  if (filter.audience) list = list.filter(p => p.audience === filter.audience || p.audience === 'both');
  // Newest first
  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return list;
}

function approveProposal(id, approver) {
  return updateProposal(id, {
    status: 'approved',
    approvedAt: new Date().toISOString(),
    approvedBy: approver,
  });
}

function rejectProposal(id, rejector) {
  return updateProposal(id, {
    status: 'rejected',
    rejectedAt: new Date().toISOString(),
    approvedBy: rejector,
  });
}

module.exports = {
  createProposal,
  getProposal,
  updateProposal,
  listProposals,
  approveProposal,
  rejectProposal,
};
