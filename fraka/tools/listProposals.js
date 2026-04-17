const proposalsStore = require('../proposalsStore');

function listProposals(filter = {}) {
  return proposalsStore.listProposals(filter);
}

module.exports = { listProposals };
