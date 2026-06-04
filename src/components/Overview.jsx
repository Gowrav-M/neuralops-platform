import { useState } from 'react';

export default function Overview({
  stats,
  traces,
  incidents,
  systemStatus,
  apiStatus,
  setActiveTab,
  setSelectedTrace,
  setDrawerOpen,
  timerActive,
  setTimerActive,
  timerSeconds,
  formatTime
}) {
  const [tooltipData, setTooltipData] = useState({ visible: false, x: 0, y: 0, text: '' });
  const [activePoint, setActivePoint] = useState(11); // snap to last point initially

  const sortedTraces = [...traces].slice(0, 12).reverse();
  const chartSource = sortedTraces.length > 0 ? sortedTraces : [{ timestamp: 'now', tokens: 0 }];
  const maxTokens = Math.max(...chartSource.map((trace) => trace.tokens || 0), 1);
  const chartPoints = chartSource.map((trace, index) => {
    const x = chartSource.length === 1 ? 150 : 10 + (280 * index) / (chartSource.length - 1);
    const y = 115 - ((trace.tokens || 0) / maxTokens) * 90;
    return {
      x,
      y,
      val: String(trace.tokens || 0),
      time: trace.timestamp || 'now'
    };
  });
  const safeActivePoint = Math.min(activePoint, chartPoints.length - 1);
  const linePath = chartPoints.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
  const areaPath = `${linePath} L ${chartPoints.at(-1).x} 120 L ${chartPoints[0].x} 120 Z`;

  const workflowMap = traces.reduce((acc, trace) => {
    const name = trace.toolCalls || trace.session || 'direct_model_call';
    const cost = Number.parseFloat(String(trace.cost).replace('$', '')) || 0;
    const latency = Number.parseFloat(String(trace.latency).replace('s', '')) || 0;
    const current = acc.get(name) || { name, calls: 0, totalCost: 0, totalLatency: 0 };
    current.calls += 1;
    current.totalCost += cost;
    current.totalLatency += latency;
    acc.set(name, current);
    return acc;
  }, new Map());
  const expensiveWorkflows = [...workflowMap.values()]
    .sort((a, b) => b.totalCost - a.totalCost)
    .slice(0, 5)
    .map((flow) => ({
      name: flow.name,
      calls: flow.calls,
      avgCost: `$${(flow.totalCost / Math.max(flow.calls, 1)).toFixed(3)}`,
      totalCost: `$${flow.totalCost.toFixed(3)}`,
      latency: `${(flow.totalLatency / Math.max(flow.calls, 1)).toFixed(2)}s`
    }));

  const handleBarHover = (e, val, label) => {
    const rect = e.target.getBoundingClientRect();
    setTooltipData({
      visible: true,
      x: rect.left - 50 + rect.width / 2,
      y: rect.top - 40,
      text: `${label}: ${val}`
    });
  };

  const handleBarLeave = () => {
    setTooltipData({ visible: false, x: 0, y: 0, text: '' });
  };

  const modelCostMap = traces.reduce((acc, trace) => {
    const cost = Number.parseFloat(String(trace.cost).replace('$', '')) || 0;
    acc.set(trace.model, (acc.get(trace.model) || 0) + cost);
    return acc;
  }, new Map());
  const costByModel = [...modelCostMap.entries()]
    .map(([model, cost]) => ({ model, cost }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 4);
  const todaySpend = costByModel.reduce((sum, item) => sum + item.cost, 0);
  const maxModelCost = Math.max(...costByModel.map((item) => item.cost), 0.001);
  const blockedCount = traces.filter((trace) => trace.status === 'blocked').length;
  const healthyScore = traces.length === 0 ? 100 : Math.round(((traces.length - blockedCount) / traces.length) * 100);
  const warningCount = traces.filter((trace) => trace.status === 'warning').length;
  const failedCount = traces.filter((trace) => trace.status === 'failed').length;
  const successfulCount = traces.filter((trace) => trace.status === 'success').length;
  const featureState = (id) => systemStatus?.features?.find((feature) => feature.id === id)?.state || 'not_configured';
  const featureEvidence = (id) => systemStatus?.features?.find((feature) => feature.id === id)?.evidence || 'Waiting for backend status';
  const providerConfigured = systemStatus?.providers?.some((provider) => provider.configured && provider.id !== 'local');
  const launchSteps = [
    {
      label: 'Connect an app',
      state: featureState('connect_sdk'),
      evidence: featureEvidence('connect_sdk'),
      action: 'Create ingest key',
      tab: 'Connect',
    },
    {
      label: 'Add live provider',
      state: providerConfigured ? 'live_provider' : featureState('provider_gateway'),
      evidence: providerConfigured ? 'At least one live model provider is configured' : featureEvidence('provider_gateway'),
      action: 'Open provider gateway',
      tab: 'Settings',
    },
    {
      label: 'Run agent lab',
      state: featureState('agent_runtime'),
      evidence: featureEvidence('agent_runtime'),
      action: 'Run Neural Labs',
      tab: 'Labs',
    },
    {
      label: 'Gate a release',
      state: featureState('release_gates'),
      evidence: featureEvidence('release_gates'),
      action: 'Create release gate',
      tab: 'Evidence',
    },
  ];

  const launchBadgeClass = {
    persisted: 'badge-success',
    live_provider: 'badge-success',
    local_drill: 'badge-warning',
    not_configured: 'badge-error',
  };

  const launchStateLabel = {
    persisted: 'persisted',
    live_provider: 'live',
    local_drill: 'local',
    not_configured: 'missing',
  };

  return (
    <div className="main-panel">
      {/* Page Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">NeuralOps Control Plane</h1>
          <p className="page-subtitle">CI/CD and observability for AI workflows: connect providers, ingest traces, test agents, gate releases, and investigate failures.</p>
        </div>
      </div>

      <div className="operator-launch-board">
        <div className="launch-board-copy">
          <span className="metric-label">Production Readiness Path</span>
          <h3>Ship AI changes only after evidence exists.</h3>
          <p>
            NeuralOps is useful when every model, prompt, RAG, or agent change leaves proof:
            who ran it, which provider answered, what it cost, what failed, and why release was allowed or blocked.
          </p>
          <div className="launch-board-status-row">
            <span className={`api-status-pill ${apiStatus?.state || 'loading'}`}>{apiStatus?.state || 'loading'}</span>
            <span className="api-status-pill connected">{systemStatus?.storage || 'storage'} store</span>
            <button className="btn-primary" onClick={() => setActiveTab('Evidence')}>
              Open Evidence Center
            </button>
          </div>
        </div>
        <div className="launch-step-grid">
          {launchSteps.map((step) => (
            <button className="launch-step-card" key={step.label} onClick={() => setActiveTab(step.tab)}>
              <div className="dark-panel-title-row">
                <strong>{step.label}</strong>
                <span className={`badge ${launchBadgeClass[step.state]}`}>{launchStateLabel[step.state]}</span>
              </div>
              <p>{step.evidence}</p>
              <span>{step.action}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Top Slider and Status Row */}
      <div className="overview-top-bar">
        <div className="slider-metric-group">
          <div className="slider-metric-card">
            <span className="slider-metric-label">System Load</span>
            <div className="slider-metric-value-container">
              <span className="slider-metric-pill">{Math.min(100, traces.length * 5)}%</span>
              <div className="slider-metric-bar">
                <div className="slider-metric-fill" style={{ width: `${Math.min(100, traces.length * 5)}%` }}></div>
              </div>
            </div>
          </div>

          <div className="slider-metric-card">
            <span className="slider-metric-label">Canary Traffic</span>
            <div className="slider-metric-value-container">
              <span className="slider-metric-pill yellow">{Math.round(Number.parseFloat(stats.evalPassRate) || 0)}%</span>
              <div className="slider-metric-bar">
                <div className="slider-metric-fill yellow" style={{ width: `${Math.round(Number.parseFloat(stats.evalPassRate) || 0)}%` }}></div>
              </div>
            </div>
          </div>

          <div className="slider-metric-card">
            <span className="slider-metric-label">Sandbox Safety</span>
            <div className="slider-metric-value-container">
              <span className="slider-metric-pill">{healthyScore}%</span>
              <div className="slider-metric-bar">
                <div className="slider-metric-fill striped" style={{ width: `${healthyScore}%` }}></div>
              </div>
            </div>
          </div>
        </div>

        <div className="stat-piles">
          <div className="stat-pile-item">
            <span className="stat-pile-val">{new Set(traces.map((trace) => trace.session)).size}</span>
            <span className="stat-pile-lbl">Active<br />Sessions</span>
          </div>
          <div className="stat-pile-item">
            <span className="stat-pile-val">{traces.filter((trace) => trace.score > 0).length}</span>
            <span className="stat-pile-lbl">Evals<br />Completed</span>
          </div>
          <div className="stat-pile-item">
            <span className="stat-pile-val">{expensiveWorkflows.length}</span>
            <span className="stat-pile-lbl">Total<br />Workflows</span>
          </div>
        </div>
      </div>

      {/* Metric Cards Row */}
      <div className="metrics-grid-row">
        <div className="metric-card-square active" onClick={() => setActiveTab('Traces')}>
          <span className="metric-label">Total Requests</span>
          <span className="metric-value">{stats.totalRequests.toLocaleString()}</span>
          <span className="metric-trend up">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M1 9L9 1M9 1H3M9 1V7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            {traces.length} backend traces
          </span>
        </div>
        <div className="metric-card-square" onClick={() => setActiveTab('Traces')}>
          <span className="metric-label">Avg Latency</span>
          <span className="metric-value">{stats.avgLatency}</span>
          <span className="metric-trend down">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M1 1L9 9M9 9H3M9 9V3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            live aggregate
          </span>
        </div>
        <div className="metric-card-square" onClick={() => setActiveTab('Traces')}>
          <span className="metric-label">p95 Latency</span>
          <span className="metric-value">{stats.p95Latency}</span>
          <span className="metric-trend down">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M1 1L9 9M9 9H3M9 9V3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            live aggregate
          </span>
        </div>
        <div className="metric-card-square" onClick={() => setActiveTab('Traces')}>
          <span className="metric-label">Error Rate</span>
          <span className="metric-value">{stats.errorRate}</span>
          <span className="metric-trend down">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M1 1L9 9M9 9H3M9 9V3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            {failedCount + blockedCount} failed/blocked
          </span>
        </div>
        <div className="metric-card-square" onClick={() => setActiveTab('Cost')}>
          <span className="metric-label">Total Cost</span>
          <span className="metric-value">{stats.totalCost}</span>
          <span className="metric-trend up">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M1 9L9 1M9 1H3M9 1V7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            from trace costs
          </span>
        </div>
        <div className="metric-card-square" onClick={() => setActiveTab('Evaluations')}>
          <span className="metric-label">Eval Pass Rate</span>
          <span className="metric-value">{stats.evalPassRate}</span>
          <span className="metric-trend up">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M1 9L9 1M9 1H3M9 1V7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            {successfulCount} passing traces
          </span>
        </div>
        <div className="metric-card-square alert-violation" onClick={() => setActiveTab('Policies')}>
          <span className="metric-label">Policy Violations</span>
          <span className="metric-value">{stats.policyViolations}</span>
          <span className="metric-trend up">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M1 9L9 1M9 1H3M9 1V7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            {warningCount + blockedCount} risky traces
          </span>
        </div>
        <div className="metric-card-square alert-incident" onClick={() => setActiveTab('Incidents')}>
          <span className="metric-label">Active Incidents</span>
          <span className="metric-value">{stats.activeIncidents}</span>
          <span className="metric-trend neutral">0.0%</span>
        </div>
      </div>

      {/* Main Charts and Dial Cards */}
      <div className="dashboard-cards-grid">
        {/* Progress chart */}
        <div className="card-container">
          <div className="card-header-row">
            <span className="card-title">Requests Over Time</span>
            <div className="card-link-arrow" onClick={() => setActiveTab('Traces')}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M2 10L10 2M10 2H4M10 2V8" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
              <span style={{ fontSize: '24px', fontWeight: '600', transition: 'all 0.15s ease' }}>
                {safeActivePoint !== null ? chartPoints[safeActivePoint].val : '0'}
              </span>
              <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Total Calls</span>
            </div>
            {activePoint !== null && (
              <span style={{ fontSize: '11px', color: 'var(--accent-gold)', fontWeight: '600' }}>
                {chartPoints[safeActivePoint].time}
              </span>
            )}
          </div>

          <div className="chart-container-inner">
            <svg
              className="chart-svg-box"
              viewBox="0 0 300 130"
              onMouseMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const mouseX = ((e.clientX - rect.left) / rect.width) * 300;
                let closestIndex = 0;
                let minDiff = Infinity;
                chartPoints.forEach((pt, idx) => {
                  const diff = Math.abs(pt.x - mouseX);
                  if (diff < minDiff) {
                    minDiff = diff;
                    closestIndex = idx;
                  }
                });
                setActivePoint(closestIndex);
              }}
              onMouseLeave={() => setActivePoint(chartPoints.length - 1)}
            >
              <defs>
                <linearGradient id="chart-gradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--accent-gold)" stopOpacity="0.4" />
                  <stop offset="100%" stopColor="var(--bg-card)" stopOpacity="0.0" />
                </linearGradient>
              </defs>
              <line x1="10" y1="120" x2="290" y2="120" className="chart-axis-line" />
              {/* Grid lines */}
              <line x1="10" y1="90" x2="290" y2="90" className="chart-grid-line" />
              <line x1="10" y1="60" x2="290" y2="60" className="chart-grid-line" />
              <line x1="10" y1="30" x2="290" y2="30" className="chart-grid-line" />

              {/* Area Under Curve */}
              <path
                d={areaPath}
                className="chart-path-fill"
              />

              {/* Main Line */}
              <path
                d={linePath}
                className="chart-path-main"
              />

              {/* Interactive guidelines */}
              {activePoint !== null && (
                <>
                  <line
                    x1={chartPoints[safeActivePoint].x}
                    y1="10"
                    x2={chartPoints[safeActivePoint].x}
                    y2="120"
                    stroke="rgba(26, 26, 25, 0.15)"
                    strokeDasharray="3 3"
                    strokeWidth="1.5"
                  />
                  <line
                    x1="10"
                    y1={chartPoints[safeActivePoint].y}
                    x2="290"
                    y2={chartPoints[safeActivePoint].y}
                    stroke="rgba(26, 26, 25, 0.08)"
                    strokeDasharray="3 3"
                  />
                  {/* Highlight Snapping Dot */}
                  <circle
                    cx={chartPoints[safeActivePoint].x}
                    cy={chartPoints[safeActivePoint].y}
                    r="6"
                    fill="var(--text-primary)"
                    stroke="var(--accent-gold)"
                    strokeWidth="2.5"
                    style={{ transition: 'cx 0.1s ease, cy 0.1s ease' }}
                  />
                </>
              )}
            </svg>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'var(--text-secondary)' }}>
            <span>08:00 AM</span>
            <span>12:00 PM</span>
            <span>04:00 PM</span>
            <span>08:00 PM</span>
          </div>
        </div>

        {/* Real-time Incident Tracker Circular Dial */}
        <div className="card-container">
          <div className="card-header-row">
            <span className="card-title">Latency Monitor</span>
            <div className="card-link-arrow" onClick={() => setActiveTab('Traces')}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M2 10L10 2M10 2H4M10 2V8" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
          </div>

          <div className="time-tracker-dial">
            <div className="circular-gauge-container">
              <svg className="circular-gauge-svg">
                <circle cx="65" cy="65" r="54" className="gauge-bg" />
                <circle
                  cx="65"
                  cy="65"
                  r="54"
                  className={`gauge-fill ${timerActive ? '' : 'success'}`}
                  style={{
                    strokeDasharray: '339.3',
                    strokeDashoffset: timerActive ? (339.3 - (339.3 * (timerSeconds % 60)) / 60).toString() : '90'
                  }}
                />
              </svg>
              <div className="gauge-text-overlay">
                <span className="gauge-value">{formatTime(timerSeconds)}</span>
                <span className="gauge-subtext">uptime clock</span>
              </div>
            </div>

            <div className="timer-controls">
              <button
                className={`timer-btn ${timerActive ? 'active' : ''}`}
                onClick={() => setTimerActive(!timerActive)}
                title={timerActive ? "Pause Uptime Clock" : "Resume Uptime Clock"}
              >
                {timerActive ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="4" y="4" width="6" height="16" rx="1"/>
                    <rect x="14" y="4" width="6" height="16" rx="1"/>
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8 5v14l11-7z"/>
                  </svg>
                )}
              </button>
              <span style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 500 }}>
                {timerActive ? 'Uptime clock running' : 'Uptime clock paused'}
              </span>
            </div>
          </div>
        </div>

        {/* Cost breakdown */}
        <div className="card-container">
          <div className="card-header-row">
            <span className="card-title">Cost by Model</span>
            <div className="card-link-arrow" onClick={() => setActiveTab('Cost')}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M2 10L10 2M10 2H4M10 2V8" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
            <span style={{ fontSize: '24px', fontWeight: '600' }}>${todaySpend.toFixed(3)}</span>
            <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Today's Spend</span>
          </div>

          <div className="chart-container-inner" style={{ paddingBottom: '10px' }}>
            <svg className="chart-svg-box" viewBox="0 0 300 130">
              <line x1="10" y1="120" x2="290" y2="120" className="chart-axis-line" />
              {costByModel.map((item, index) => {
                const barWidth = 36;
                const gap = 32;
                const x = 32 + index * (barWidth + gap);
                const height = Math.max(4, (item.cost / maxModelCost) * 100);
                const y = 120 - height;
                return (
                  <g key={item.model}>
                    <rect
                      x={x}
                      y={y}
                      width={barWidth}
                      height={height}
                      className={`chart-bar ${index === 0 ? 'yellow' : ''}`}
                      onMouseEnter={(e) => handleBarHover(e, `$${item.cost.toFixed(3)}`, item.model)}
                      onMouseLeave={handleBarLeave}
                    />
                    <text
                      x={x + barWidth/2}
                      y="132"
                      textAnchor="middle"
                      style={{ fontSize: '9px', fill: 'var(--text-secondary)', fontFamily: 'var(--font-sans)' }}
                    >
                      {item.model.split('-')[0]}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
        </div>
      </div>

      {/* Floating Chart Tooltip */}
      {tooltipData.visible && (
        <div
          className="chart-tooltip"
          style={{
            display: 'block',
            left: `${tooltipData.x}px`,
            top: `${tooltipData.y}px`,
            transform: 'translateY(-100%)'
          }}
        >
          {tooltipData.text}
        </div>
      )}

      {/* Calendar Widget and Tables Section */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '24px' }}>
        {/* Left Side: Recent Traces Table */}
        <div className="table-container" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '15px', fontWeight: '600' }}>Recent API Traces</span>
            <button className="btn-secondary" style={{ padding: '4px 10px', fontSize: '11px' }} onClick={() => setActiveTab('Traces')}>
              View All Traces
            </button>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table className="dense-table">
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Model</th>
                  <th>Latency</th>
                  <th>Cost</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {traces.length > 0 ? traces.slice(0, 5).map((trace, index) => (
                  <tr key={`${trace.id}-${index}`} onClick={() => { setSelectedTrace(trace); setDrawerOpen(true); }}>
                    <td>{trace.timestamp}</td>
                    <td className="code-font">{trace.model}</td>
                    <td>{trace.latency}</td>
                    <td>{trace.cost}</td>
                    <td>
                      <span className={`badge ${
                        trace.status === 'success' ? 'badge-success' :
                        trace.status === 'warning' ? 'badge-warning' : 'badge-error'
                      }`}>{trace.status}</span>
                    </td>
                  </tr>
                )) : (
                  <tr>
                    <td colSpan="5" style={{ color: 'var(--text-secondary)' }}>No backend traces available.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right Side: Active Incidents List */}
        <div className="dark-panel-container">
          <div className="dark-panel-title-row">
            <span className="dark-panel-title">Active Platform Incidents</span>
            <span className="badge badge-warning" style={{ fontSize: '10px' }}>{incidents.filter(i => i.status !== 'Resolved').length} Active</span>
          </div>

          <div className="dark-list">
            {incidents.length > 0 ? incidents.map((incident) => (
              <div key={incident.id} className="dark-list-item" onClick={() => setActiveTab('Incidents')}>
                <div className="item-left">
                  <div className="item-icon-box" style={{ color: incident.severity === 'Critical' ? 'var(--color-error)' : 'var(--color-warning)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: '13px', height: '13px' }}>
                      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                      <line x1="12" y1="9" x2="12" y2="13" />
                      <line x1="12" y1="17" x2="12.01" y2="17" />
                    </svg>
                  </div>
                  <div className="item-meta">
                    <span className="item-title">{incident.title}</span>
                    <span className="item-subtitle">Owner: {incident.owner} | {incident.time}</span>
                  </div>
                </div>
                <div>
                  <span className={`badge ${incident.severity === 'Critical' ? 'badge-error' : 'badge-warning'}`} style={{ fontSize: '8px' }}>
                    {incident.severity}
                  </span>
                </div>
              </div>
            )) : (
              <div className="dark-list-item">
                <div className="item-meta">
                  <span className="item-title">No active incidents</span>
                  <span className="item-subtitle">Backend has no incident records.</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Top Expensive Workflows Grid Card */}
      <div className="table-container" style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <span style={{ fontSize: '15px', fontWeight: '600' }}>Top Expensive Workflow Operations</span>

        <table className="dense-table">
          <thead>
            <tr>
              <th>Workflow Name</th>
              <th>Total Executions</th>
              <th>Avg Latency</th>
              <th>Avg Cost per Call</th>
              <th>Accumulated Cost</th>
            </tr>
          </thead>
          <tbody>
            {expensiveWorkflows.length > 0 ? expensiveWorkflows.map((flow) => (
              <tr key={flow.name}>
                <td className="code-font">{flow.name}</td>
                <td>{flow.calls.toLocaleString()}</td>
                <td>{flow.latency}</td>
                <td>{flow.avgCost}</td>
                <td style={{ fontWeight: '600' }}>{flow.totalCost}</td>
              </tr>
            )) : (
              <tr>
                <td colSpan="5" style={{ color: 'var(--text-secondary)' }}>No workflow cost records are available yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
