const CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0A0A0A;
    color: #ECECEC;
    font-family: system-ui, -apple-system, sans-serif;
    line-height: 1.6;
    padding: 24px;
  }
  .container { max-width: 1200px; margin: 0 auto; }

  /* Header */
  .header {
    background: #1E3A5F;
    border-radius: 12px;
    padding: 24px 32px;
    margin-bottom: 24px;
  }
  .header h1 { font-size: 24px; font-weight: 700; }
  .header .meta { color: #aaa; font-size: 14px; margin-top: 8px; }
  .header .tagline { color: #88bbdd; font-size: 14px; margin-top: 4px; }

  /* Cards */
  .card {
    background: #141414;
    border: 1px solid #222222;
    border-radius: 10px;
    padding: 20px;
    margin-bottom: 16px;
  }
  .card h2 { font-size: 18px; margin-bottom: 12px; }
  .card h3 { font-size: 16px; margin-bottom: 8px; color: #ccc; }

  /* Stats bar */
  .stats-bar {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 24px;
  }
  .stat-item {
    background: #141414;
    border: 1px solid #222;
    border-radius: 8px;
    padding: 12px 20px;
    text-align: center;
    flex: 1;
    min-width: 120px;
  }
  .stat-item .value { font-size: 28px; font-weight: 700; }
  .stat-item .label { font-size: 12px; color: #888; text-transform: uppercase; }

  /* Severity badges */
  .badge { display: inline-block; padding: 2px 10px; border-radius: 4px; font-size: 12px; font-weight: 600; }
  .badge-p0 { background: #FF3B3020; border: 1px solid #FF3B30; color: #FF3B30; }
  .badge-p1 { background: #FF950020; border: 1px solid #FF9500; color: #FF9500; }
  .badge-p2 { background: #FFCC0020; border: 1px solid #FFCC00; color: #FFCC00; }
  .badge-p3 { background: #34AADC20; border: 1px solid #34AADC; color: #34AADC; }

  /* Status badges */
  .badge-pass { background: #1B4D2E; color: #34C759; }
  .badge-warn { background: #4D3A00; color: #FFCC00; }
  .badge-fail { background: #4D0A0A; color: #FF3B30; }
  .badge-unknown { background: #333; color: #888; }
  .badge-skipped { background: #1a1a2e; color: #7b68ee; }

  /* Bug cards */
  .bug-card {
    background: #141414;
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 12px;
  }
  .bug-card.p0 { border-left: 4px solid #FF3B30; }
  .bug-card.p1 { border-left: 4px solid #FF9500; }
  .bug-card.p2 { border-left: 4px solid #FFCC00; }
  .bug-card.p3 { border-left: 4px solid #34AADC; }
  .bug-card .bug-title { font-weight: 600; margin-bottom: 8px; }
  .bug-card .bug-detail { font-size: 14px; color: #aaa; margin: 4px 0; }
  .bug-card .bug-detail strong { color: #ccc; }

  /* Tables */
  table { width: 100%; border-collapse: collapse; margin: 12px 0; }
  th { background: #1a1a1a; padding: 10px 12px; text-align: left; font-size: 13px; color: #888; text-transform: uppercase; border-bottom: 1px solid #333; }
  td { padding: 10px 12px; border-bottom: 1px solid #1a1a1a; font-size: 14px; }
  tr:hover { background: #1a1a1a; }

  /* UX friction cards */
  .friction-card {
    background: #141414;
    border: 1px solid #222;
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 12px;
  }
  .friction-card .friction-badge { font-weight: 600; margin-bottom: 6px; }
  .friction-card .friction-badge.high { color: #FF3B30; }
  .friction-card .friction-badge.medium { color: #FFCC00; }
  .friction-card .friction-badge.low { color: #34AADC; }

  /* Screenshot */
  .screenshot-container { margin: 16px 0; }
  .screenshot-container img {
    width: 100%;
    border-radius: 8px;
    border: 1px solid #333;
  }

  /* Step section */
  .step-section {
    background: #141414;
    border: 1px solid #222;
    border-radius: 10px;
    padding: 20px;
    margin-bottom: 16px;
  }
  .step-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
  }
  .step-header h3 { flex: 1; }

  /* Collapsible */
  details { margin-bottom: 12px; }
  summary {
    cursor: pointer;
    padding: 12px 16px;
    background: #141414;
    border: 1px solid #222;
    border-radius: 8px;
    font-weight: 600;
  }
  summary:hover { background: #1a1a1a; }
  details[open] summary { border-radius: 8px 8px 0 0; }
  details .detail-content {
    padding: 16px;
    background: #141414;
    border: 1px solid #222;
    border-top: none;
    border-radius: 0 0 8px 8px;
  }

  /* Grid */
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 768px) { .grid-2 { grid-template-columns: 1fr; } }

  /* Context panel */
  .context-panel {
    background: #1E3A5F20;
    border: 1px solid #1E3A5F;
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 24px;
  }
  .context-panel .label { font-size: 12px; color: #88bbdd; text-transform: uppercase; margin-bottom: 4px; }

  /* Footer */
  .footer {
    text-align: center;
    padding: 24px;
    color: #555;
    font-size: 13px;
    border-top: 1px solid #222;
    margin-top: 32px;
  }

  /* Print */
  @media print {
    body { background: white; color: black; }
    .card, .step-section, .bug-card { border-color: #ccc; background: white; }
    .header { background: #ddd; }
  }
`;

module.exports = { CSS };
