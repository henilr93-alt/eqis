const { callClaude, selectMode } = require('../../utils/tokenOptimizer');
const { PLATFORM_CONTEXT } = require('../../config/platformContext');
const logger = require('../../utils/logger');
const { STEP_CONTEXTS } = require('./stepPrompts');

const EVALUATOR_SYSTEM = `${PLATFORM_CONTEXT}
Analyze this screenshot for bugs, UX friction, and UI amendments.

Respond ONLY in JSON:
{
  "stepName": string,
  "overallStatus": "PASS"|"WARN"|"FAIL",
  "loadTimeAssessment": "FAST"|"ACCEPTABLE"|"SLOW"|"UNKNOWN",
  "bugs": [{"id": string, "severity": "P0"|"P1"|"P2"|"P3", "title": string, "description": string, "elementLocation": string, "devFixRequired": string, "estimatedEffort": "1h"|"4h"|"1d"|"2-3d"|"1w+"}],
  "uxFriction": [{"id": string, "frictionLevel": "HIGH"|"MEDIUM"|"LOW", "observation": string, "agentImpact": string, "recommendation": string}],
  "uiAmendments": [{"id": string, "element": string, "currentState": string, "recommendedChange": string, "priority": "HIGH"|"MEDIUM"|"LOW"}],
  "positives": [string],
  "stepCompletion": "COMPLETED"|"PARTIAL"|"BLOCKED"
}`;

async function evaluateStep(screenshotBase64, stepName, scenario) {
  const stepContext = STEP_CONTEXTS[stepName] || `Step: ${stepName}`;
  const scenarioLabel = scenario?.label || 'Unknown scenario';
  const isMirror = scenario?.source === 'session_mirror';

  // Pass 1: Fast triage
  const triage = await callClaude({
    system: PLATFORM_CONTEXT,
    userText: `Screenshot of ${stepName}. Return JSON only: { "status": "PASS"|"WARN"|"FAIL", "issues": [string] }`,
    imageBase64: screenshotBase64,
    mode: 'FAST',
    label: `triage/${stepName}`,
  });

  // If PASS and not a mirror scenario — skip deep eval
  if (triage?.status === 'PASS' && !isMirror) {
    logger.info(`[EVAL] ${stepName} -> PASS (triage only)`);
    return {
      stepName,
      overallStatus: 'PASS',
      loadTimeAssessment: 'UNKNOWN',
      bugs: [],
      uxFriction: [],
      uiAmendments: [],
      positives: triage.issues || [],
      stepCompletion: 'COMPLETED',
      evalMode: 'FAST_TRIAGE',
    };
  }

  // Pass 2: Full evaluation
  const mode = selectMode({
    engineType: 'journey',
    isMirrorScenario: isMirror,
    stepName,
    hasBugs: triage?.issues?.length > 0,
  });

  logger.info(`[EVAL] ${stepName} -> ${triage?.status || 'UNKNOWN'} — escalating to ${mode}`);

  const userPrompt = `Step: ${stepName} | Context: ${stepContext} | Scenario: ${scenarioLabel}
Triage found: ${JSON.stringify(triage?.issues || [])}
Provide full QA evaluation.`;

  const result = await callClaude({
    system: EVALUATOR_SYSTEM,
    userText: userPrompt,
    imageBase64: screenshotBase64,
    mode,
    label: `full/${stepName}`,
  });

  if (result) {
    result.evalMode = mode;
    return result;
  }

  return {
    stepName,
    overallStatus: 'UNKNOWN',
    loadTimeAssessment: 'UNKNOWN',
    bugs: [],
    uxFriction: [],
    uiAmendments: [],
    positives: [],
    stepCompletion: 'UNKNOWN',
    error: 'parse_failed',
  };
}

module.exports = { evaluateStep };
