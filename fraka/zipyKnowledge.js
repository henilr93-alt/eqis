// Zipy Knowledge Base — injected into FRAKA's prompt when processing
// Zipy Intelligence data or answering questions about Zipy sessions.
//
// Source: zipy.ai website, docs.zipy.ai, and EQIS engine1-zipy/ codebase.

const ZIPY_KNOWLEDGE = `
=== ZIPY INTELLIGENCE KNOWLEDGE BASE ===
You have deep expertise in Zipy (https://app.zipy.ai) — the session replay
and error tracking platform Etrav uses for real-user monitoring.

WHAT ZIPY IS:
Zipy is a proactive debugging tool that records real user sessions on web and
mobile apps. It captures pixel-perfect replays of every click, scroll, and
interaction, along with console logs, network requests, API calls, errors with
stack traces, and performance data. It helps identify bugs, UX friction, rage
clicks, dead clicks, conversion blockers, and session abandonment patterns.

HOW ZIPY SESSIONS WORK:
- Zipy's JavaScript SDK records user sessions automatically once installed.
- Each session captures: mouse movements, clicks, scrolls, form interactions,
  page navigation, console events, network requests/responses, JS errors with
  stack traces, API latencies, and custom events.
- Smart session stitching tracks users across multiple browser tabs.
- Sessions can be replayed with pixel-perfect fidelity.
- PII is automatically masked; sensitive fields use zipy.block().

ZIPY DASHBOARD STRUCTURE:
- Sessions List: main view showing all recorded sessions with metadata
  (user, duration, device, OS, browser, location, error count, timestamp).
- Session Detail: full replay player with timeline, events panel,
  console logs tab, network tab, errors tab, and user actions overlay.
- Errors Dashboard: aggregated JS errors and API errors with counts,
  affected users, first/last seen, and stack traces.
- Performance: API latency distribution, slow requests, error rates.
- Filters: 25+ filter categories including:
  - Time range (Last 1h / 24h / 7d / 30d / custom)
  - User identifiers (email, user ID, custom attributes)
  - Device type (desktop/mobile/tablet), OS, browser
  - Geographic location
  - Session duration
  - Error presence / type (JS error, API error, console error)
  - Rage clicks, dead clicks
  - Page URL, referrer
  - Custom events
  - API status codes, latency thresholds

KEY ZIPY TERMINOLOGY:
- Session: one continuous user visit, auto-segmented by inactivity.
- Rage Click: rapid repeated clicks on the same element — frustration signal.
- Dead Click: click on a non-interactive element — indicates UX confusion.
- Error Boundary: point where an unhandled JS error disrupts the user flow.
- Session Stitching: linking sessions from the same user across tabs/visits.
- Frustration Signal: any user behaviour suggesting confusion or annoyance
  (rage clicks, dead clicks, rapid back-navigation, session abandonment).
- Console Event: any console.log/warn/error captured during the session.
- Network Log: every XHR/fetch request with method, URL, status, latency,
  request body, and response body.
- Stack Trace: full JS call stack for captured errors.
- PII Masking: automatic redaction of sensitive input fields.
- AI Summary: Zipy's AI-generated summary highlighting key actions,
  frustration points, and errors in a session.
- AI Resolve: Zipy's AI-powered root cause analysis for JS errors.

HOW EQIS USES ZIPY (Engine 1 — Zipy Intelligence):
1. EQIS logs into Zipy at ${process.env.ZIPY_BASE_URL || 'https://app.zipy.ai'}
   using Playwright browser automation.
2. Navigates to Sessions → filters to "Last 24 hours" (or configured window).
3. sessionHarvester scrolls through the session list and extracts up to
   ${process.env.ZIPY_SESSIONS_TO_HARVEST || 20} sessions with metadata
   (user, duration, error count, device, timestamp).
4. sessionSelector uses Claude AI to pick the ${process.env.ZIPY_SESSIONS_TO_DEEP_ANALYZE || 5}
   most valuable sessions (prioritising: error count >= 2, rage clicks,
   long duration without payment completion, mobile sessions).
5. sessionAnalyzer deep-dives into each selected session: records user
   interactions, errors, UI issues, and generates a structured analysis.
6. bugAggregator deduplicates bugs across sessions and identifies "systemic"
   issues (same bug in 2+ sessions).
7. sessionMirror converts real user failure patterns into EQIS test scenarios
   so Journey Engine can replay them automatically.
8. trendExtractor identifies search patterns, booking trends, and generates
   recommended test routes.
9. trendCache stores the output for Engines 2 (Journey) and 3 (Search Pulse)
   to consume as dynamic scenario sources.
10. A detailed HTML report is generated and metrics are written to
    metricsHistory.json.

WHAT TO LOOK FOR WHEN ANALYSING ZIPY DATA:
- Sessions with errors >= 2: likely systemic bugs, not edge cases.
- Rage click clusters: indicate broken buttons or unresponsive UI.
- Dead clicks on pricing/CTA: revenue-impacting UX issues.
- Sessions that reach search results but never click a result: search quality
  or relevance issue.
- Sessions that abandon at payment: booking flow or price-shock issue.
- API 500s or timeouts: backend instability.
- Mobile-specific errors: responsive design bugs.
- Sessions from new vs returning users: onboarding vs loyalty friction.
- Geographic patterns: CDN or regional backend issues.
- Browser-specific errors: compatibility bugs.

ZIPY CREDENTIALS FOR EQIS:
- URL: app.zipy.ai
- Email: configured in .env (ZIPY_EMAIL)
- Password: configured in .env (ZIPY_PASSWORD)
- Never reveal these in chat — they are .env secrets.

ZIPY SELECTORS USED BY EQIS (for Playwright automation):
- Login: email input, password input, login button (dynamic selectors
  handled by zipyLogin.js with fallback strategies).
- Sessions page: session list rows, session metadata cells, scroll container,
  "Load More" button.
- Filters: date range picker, filter dropdowns, search input.
- Session detail: replay player, timeline, events panel, tabs (console,
  network, errors).

WHEN FRAKA DISCUSSES ZIPY:
- Always cite specific session counts, error types, and patterns.
- Distinguish between systemic bugs (multi-session) vs one-off errors.
- Map Zipy findings to EQIS engine test coverage gaps.
- Recommend new test scenarios based on real user failure patterns.
- Track how long a Zipy-discovered bug persists using issueTracker.
- Consider whether the bug was found by Zipy alone or also by Search Pulse
  or Journey Engine — cross-engine correlation adds confidence.
=== END ZIPY KNOWLEDGE BASE ===
`;

// Real operational findings from EQIS Zipy Intelligence Engine
const ZIPY_ACTUAL_BEHAVIOR = `
=== ZIPY OPERATIONAL REALITY (FROM EQIS ENGINE1-ZIPY) ===

LOGIN FLOW SPECIFICS:
- Login URL: https://app.zipy.ai/login (redirects from base URL)
- Email field: input[type="email"] or input[name="email"]
- Password field: input[type="password"] or input[name="password"]
- Login button: button[type="submit"] or button containing "Sign in"/"Login"
- Post-login redirect: typically to /sessions or /dashboard
- Session persistence: cookies valid for ~7 days, no re-auth needed

OTP FLOW (2FA ENABLED ACCOUNTS):
- After email/password, redirects to /verify-otp or similar
- OTP input: 6-digit numeric field, often split into individual boxes
- OTP source: SMS or authenticator app (configured per account)
- Timeout: OTP expires in 5-10 minutes
- Fallback: "Resend OTP" button available after 60 seconds
- EQIS handles OTP via otpLogin.js with manual intervention prompts

SESSION REDIRECT BEHAVIOR:
- Fresh login → /sessions (main sessions list)
- Bookmark direct URLs → preserves target path after auth
- Deep links to session detail → /sessions/{sessionId} format
- Filter state → preserved in URL query params
- Logout → clears session, redirects to /login

DOM LOADING REQUIREMENTS:
- Standard page.waitForLoadState() insufficient for Zipy SPA
- Requires waitUntil: 'domcontentloaded' PLUS additional selectors
- Session list: wait for .session-row or [data-testid="session-item"]
- Session detail: wait for .replay-player or .timeline-container
- Infinite scroll: "Load More" requires scroll + wait for new rows
- Network requests: wait for API responses before DOM interactions

CURRENT HARVESTER BLOCKERS:
- Rate limiting: Zipy API throttles at ~100 requests/hour
- Captcha challenges: triggered by rapid navigation (rare but critical)
- Session timeout: long analysis sessions (>30min) may expire auth
- Memory leaks: Playwright contexts accumulate, requiring periodic cleanup
- Stale selectors: Zipy UI updates can break automation selectors
- Infinite scroll pagination: challenging to determine "end" of sessions

DOM EXPLORATION STATUS:
- Session metadata extraction: STABLE (user, duration, errors, device)
- Session detail navigation: STABLE (click to open replay)
- Replay player interaction: PARTIALLY STABLE (timeline scrubbing works)
- Console logs extraction: STABLE (text content accessible)
- Network logs extraction: STABLE (XHR/fetch requests visible)
- Error extraction: STABLE (stack traces readable)
- User action timeline: EXPERIMENTAL (mouse/click events partial)
- Filter automation: STABLE (date range, error type, device filters)
- Bulk session export: NOT IMPLEMENTED (manual download only)

KNOWN SELECTOR PATTERNS:
- Sessions list: .sessions-table tbody tr, .session-row, [data-session-id]
- Session metadata: .session-user, .session-duration, .session-errors
- Replay player: .zipy-player, .replay-container, .timeline-scrubber
- Console panel: .console-logs, .console-entry, .log-level-error
- Network panel: .network-requests, .request-row, .status-code
- Error details: .error-stack-trace, .error-message, .error-location
- Navigation: .sidebar-nav, .breadcrumbs, .back-button

SESSION SAMPLING STRATEGY (CEO DIRECTIVE COMPLIANCE):
- Target: 5 sessions every 10 minutes (per directive #1)
- Selection criteria: error_count >= 2, mobile sessions, rage clicks
- Geographic split: 50% domestic (India) / 50% international (per directive #3)
- Time window: Last 24 hours (configurable)
- Deduplication: skip sessions with identical user_id + timestamp
- Priority ranking: errors > rage_clicks > long_duration > mobile

REAL-TIME BUG REPORTING (CEO DIRECTIVE COMPLIANCE):
- P0 threshold: JS errors affecting >5% of sessions (per directive #2)
- Alert format: [P0] Systemic issue in {component} - {session_count} affected
- Cost estimate: include token usage + browser time (per directive #2)
- Escalation: immediate Slack/email for P0, hourly summary for P1-P2

=== END ZIPY OPERATIONAL REALITY ===
`;

module.exports = { ZIPY_KNOWLEDGE, ZIPY_ACTUAL_BEHAVIOR };