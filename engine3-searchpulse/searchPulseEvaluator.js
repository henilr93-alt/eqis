const { callClaude, selectMode } = require('../utils/tokenOptimizer');
const { PLATFORM_CONTEXT } = require('../config/platformContext');
const logger = require('../utils/logger');

const SEARCH_PULSE_SYSTEM = `${PLATFORM_CONTEXT}
Evaluate SEARCH and RESULTS quality only. Focus on: result quality, API health, filter accuracy, performance, data completeness.

Respond ONLY in JSON:
{
  "searchType": "flight"|"hotel",
  "resultsLoaded": boolean,
  "resultCount": number|null,
  "loadTimeAssessment": "FAST"|"ACCEPTABLE"|"SLOW"|"TIMEOUT",
  "resultQuality": "GOOD"|"PARTIAL"|"POOR"|"EMPTY",
  "apiHealthStatus": "HEALTHY"|"DEGRADED"|"ERROR",
  "apiIssuesFound": [{"type": string, "description": string, "affectsField": string}],
  "filterAccuracy": {"tested": boolean, "workedCorrectly": boolean|null, "issue": string|null},
  "dataCompletenessIssues": [string],
  "criticalFindingsForSearchTeam": [string],
  "positives": [string],
  "overallSearchHealth": "HEALTHY"|"WARN"|"CRITICAL"
}`;

async function evaluateSearchPulse(screenshotBase64, searchType, scenario, metrics) {
  const scenarioLabel = scenario?.label || 'Unknown';
  const isMirror = scenario?.source === 'session_mirror';

  const mode = selectMode({
    engineType: 'searchpulse',
    isMirrorScenario: isMirror,
    stepStatus: metrics.resultCount > 0 ? 'healthy' : 'unknown',
    stepName: searchType,
  });

  const userPrompt = `Search type: ${searchType} | Scenario: ${scenarioLabel}
Load time: ${metrics.loadTimeMs}ms | Result count: ${metrics.resultCount}
Evaluate search results quality.`;

  logger.info(`[PULSE-EVAL] Evaluating: ${searchType} — ${scenarioLabel} (mode: ${mode})`);

  try {
    // Call Claude with rawText:true to get string response
    const rawResponse = await callClaude({
      system: SEARCH_PULSE_SYSTEM,
      userText: userPrompt,
      imageBase64: screenshotBase64,
      mode,
      label: `pulse/${searchType}/${scenario.id}`,
      rawText: true // This returns a string, not parsed JSON
    });

    if (!rawResponse) {
      logger.warn(`[PULSE-EVAL] ${searchType}: Claude returned empty response`);
      return createFallbackResult(searchType, 'claude_empty_response');
    }

    // Strip markdown code fences if present (Claude sometimes wraps JSON in ```json...```)
    let cleanResponse = rawResponse.trim();
    cleanResponse = cleanResponse.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    // Parse the JSON string response
    let result;
    try {
      result = JSON.parse(cleanResponse);
      logger.info(`[PULSE-EVAL] ${searchType}: JSON parse success — ${result.overallSearchHealth} | Quality: ${result.resultQuality}`);
    } catch (parseError) {
      logger.error(`[PULSE-EVAL] ${searchType}: JSON parse failed — ${parseError.message}`);
      logger.error(`[PULSE-EVAL] ${searchType}: Raw response was: ${rawResponse.substring(0, 200)}...`);
      return createFallbackResult(searchType, 'json_parse_failed');
    }

    // Validate the parsed result has required fields
    if (!result.searchType || !result.overallSearchHealth) {
      logger.warn(`[PULSE-EVAL] ${searchType}: Parsed JSON missing required fields`);
      return createFallbackResult(searchType, 'invalid_json_structure');
    }

    logger.info(`[PULSE-EVAL] ${searchType}: Evaluation complete — ${result.overallSearchHealth}`);
    return result;

  } catch (error) {
    logger.error(`[PULSE-EVAL] ${searchType}: Claude call failed — ${error.message}`);
    return createFallbackResult(searchType, 'claude_call_failed');
  }
}

// Create a fallback result object when evaluation fails
function createFallbackResult(searchType, errorType) {
  return {
    searchType,
    resultsLoaded: false,
    resultCount: null,
    loadTimeAssessment: 'UNKNOWN',
    resultQuality: 'UNKNOWN',
    apiHealthStatus: 'UNKNOWN',
    apiIssuesFound: [],
    filterAccuracy: { tested: false, workedCorrectly: null, issue: null },
    dataCompletenessIssues: [],
    criticalFindingsForSearchTeam: [],
    positives: [],
    overallSearchHealth: 'UNKNOWN',
    error: errorType,
  };
}

module.exports = { evaluateSearchPulse };