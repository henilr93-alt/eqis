// Thin wrapper around proposalsStore.createProposal() — exposed as a "tool"
// for narrative consistency. Agent.js can also call the store directly.
const proposalsStore = require('../proposalsStore');

function proposeChange(proposal, createdBy = 'fraka') {
  return proposalsStore.createProposal(proposal, createdBy);
}

module.exports = { proposeChange };
