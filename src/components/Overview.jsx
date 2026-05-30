import { useState } from 'react';

export default function Overview({ 
  stats, 
  traces, 
  incidents, 
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

  const chartPoints = [
    { x: 10, y: 85, val: '8.2k', time: '08:00 AM' },
    { x: 35, y: 78, val: '12.4k', time: '09:00 AM' },
    { x: 60, y: 82, val: '15.1k', time: '10:00 AM' },
    { x: 85, y: 72, val: '19.8k', time: '11:00 AM' },
    { x: 110, y: 58, val: '24.2k', time: '12:00 PM' },
    { x: 135, y: 65, val: '28.9k', time: '01:00 PM' },
    { x: 160, y: 50, val: '35.4k', time: '02:00 PM' },
    { x: 185, y: 55, val: '42.1k', time: '03:00 PM' },
    { x: 210, y: 38, val: '51.3k', time: '04:00 PM' },
    { x: 235, y: 30, val: '64.8k', time: '05:00 PM' },
    { x: 260, y: 35, val: '72.0k', time: '06:00 PM' },
    { x: 290, y: 25, val: '85.2k', time: '07:00 PM' }
  ];

  // Local workflow summary used by the overview chart area.
  const expensiveWorkflows = [
    { name: 'rag_qa_agent_chain', calls: 1420, avgCost: '$0.042', totalCost: '$59.64', latency: '1.82s' },
    { name: 'code_generation_copilot', calls: 890, avgCost: '$0.058', totalCost: '$51.62', latency: '3.40s' },
    { name: 'pii_anonymizer_preprocessor', calls: 3500, avgCost: '$0.004', totalCost: '$14.00', latency: '0.12s' },
  ];

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

  // Custom SVG Chart Data
  const costByModel = [
    { model: 'claude-3.5-sonnet', cost: 145 },
    { model: 'gpt-4o', cost: 112 },
    { model: 'llama-3.1-70b', cost: 34 },
    { model: 'gpt-4o-mini', cost: 18 }
  ];

  return (
    <div className="main-panel">
      {/* Page Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">NeuralOps Control Plane</h1>
          <p className="page-subtitle">Real-time enterprise AI observability and operational guardrails.</p>
        </div>
      </div>

      {/* Top Slider and Status Row */}
      <div className="overview-top-bar">
        <div className="slider-metric-group">
          <div className="slider-metric-card">
            <span className="slider-metric-label">System Load</span>
            <div className="slider-metric-value-container">
              <span className="slider-metric-pill">15%</span>
              <div className="slider-metric-bar">
                <div className="slider-metric-fill" style={{ width: '15%' }}></div>
              </div>
            </div>
          </div>
          
          <div className="slider-metric-card">
            <span className="slider-metric-label">Canary Traffic</span>
            <div className="slider-metric-value-container">
              <span className="slider-metric-pill yellow">25%</span>
              <div className="slider-metric-bar">
                <div className="slider-metric-fill yellow" style={{ width: '25%' }}></div>
              </div>
            </div>
          </div>

          <div className="slider-metric-card">
            <span className="slider-metric-label">Sandbox Safety</span>
            <div className="slider-metric-value-container">
              <span className="slider-metric-pill">98%</span>
              <div className="slider-metric-bar">
                <div className="slider-metric-fill striped" style={{ width: '98%' }}></div>
              </div>
            </div>
          </div>
        </div>

        <div className="stat-piles">
          <div className="stat-pile-item">
            <span className="stat-pile-val">78</span>
            <span className="stat-pile-lbl">Active<br />Sessions</span>
          </div>
          <div className="stat-pile-item">
            <span className="stat-pile-val">56</span>
            <span className="stat-pile-lbl">Evals<br />Completed</span>
          </div>
          <div className="stat-pile-item">
            <span className="stat-pile-val">203</span>
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
            +12.4%
          </span>
        </div>
        <div className="metric-card-square" onClick={() => setActiveTab('Traces')}>
          <span className="metric-label">Avg Latency</span>
          <span className="metric-value">{stats.avgLatency}</span>
          <span className="metric-trend down">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M1 1L9 9M9 9H3M9 9V3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            -4.2%
          </span>
        </div>
        <div className="metric-card-square" onClick={() => setActiveTab('Traces')}>
          <span className="metric-label">p95 Latency</span>
          <span className="metric-value">{stats.p95Latency}</span>
          <span className="metric-trend down">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M1 1L9 9M9 9H3M9 9V3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            -2.1%
          </span>
        </div>
        <div className="metric-card-square" onClick={() => setActiveTab('Traces')}>
          <span className="metric-label">Error Rate</span>
          <span className="metric-value">{stats.errorRate}</span>
          <span className="metric-trend down">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M1 1L9 9M9 9H3M9 9V3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            -0.8%
          </span>
        </div>
        <div className="metric-card-square" onClick={() => setActiveTab('Cost')}>
          <span className="metric-label">Total Cost</span>
          <span className="metric-value">{stats.totalCost}</span>
          <span className="metric-trend up">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M1 9L9 1M9 1H3M9 1V7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            +18.5%
          </span>
        </div>
        <div className="metric-card-square" onClick={() => setActiveTab('Evaluations')}>
          <span className="metric-label">Eval Pass Rate</span>
          <span className="metric-value">{stats.evalPassRate}</span>
          <span className="metric-trend up">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M1 9L9 1M9 1H3M9 1V7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            +0.5%
          </span>
        </div>
        <div className="metric-card-square alert-violation" onClick={() => setActiveTab('Policies')}>
          <span className="metric-label">Policy Violations</span>
          <span className="metric-value">{stats.policyViolations}</span>
          <span className="metric-trend up">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M1 9L9 1M9 1H3M9 1V7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            +4
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
                {activePoint !== null ? chartPoints[activePoint].val : '85.2k'}
              </span>
              <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Total Calls</span>
            </div>
            {activePoint !== null && (
              <span style={{ fontSize: '11px', color: 'var(--accent-gold)', fontWeight: '600' }}>
                {chartPoints[activePoint].time}
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
                d="M 10 120 L 10 85 L 35 78 L 60 82 L 85 72 L 110 58 L 135 65 L 160 50 L 185 55 L 210 38 L 235 30 L 260 35 L 290 25 L 290 120 Z" 
                className="chart-path-fill" 
              />

              {/* Main Line */}
              <path 
                d="M 10 85 L 35 78 L 60 82 L 85 72 L 110 58 L 135 65 L 160 50 L 185 55 L 210 38 L 235 30 L 260 35 L 290 25" 
                className="chart-path-main" 
              />
              
              {/* Interactive guidelines */}
              {activePoint !== null && (
                <>
                  <line 
                    x1={chartPoints[activePoint].x} 
                    y1="10" 
                    x2={chartPoints[activePoint].x} 
                    y2="120" 
                    stroke="rgba(26, 26, 25, 0.15)" 
                    strokeDasharray="3 3"
                    strokeWidth="1.5"
                  />
                  <line 
                    x1="10" 
                    y1={chartPoints[activePoint].y} 
                    x2="290" 
                    y2={chartPoints[activePoint].y} 
                    stroke="rgba(26, 26, 25, 0.08)" 
                    strokeDasharray="3 3"
                  />
                  {/* Highlight Snapping Dot */}
                  <circle 
                    cx={chartPoints[activePoint].x} 
                    cy={chartPoints[activePoint].y} 
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
                title={timerActive ? "Pause Dashboard Stream" : "Resume Dashboard Stream"}
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
                {timerActive ? 'Live streaming traces' : 'Dashboard paused'}
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
            <span style={{ fontSize: '24px', fontWeight: '600' }}>$309.00</span>
            <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Today's Spend</span>
          </div>

          <div className="chart-container-inner" style={{ paddingBottom: '10px' }}>
            <svg className="chart-svg-box" viewBox="0 0 300 130">
              <line x1="10" y1="120" x2="290" y2="120" className="chart-axis-line" />
              {costByModel.map((item, index) => {
                const barWidth = 36;
                const gap = 32;
                const x = 32 + index * (barWidth + gap);
                const maxCost = 150;
                const height = (item.cost / maxCost) * 100;
                const y = 120 - height;
                return (
                  <g key={item.model}>
                    <rect 
                      x={x} 
                      y={y} 
                      width={barWidth} 
                      height={height} 
                      className={`chart-bar ${index === 0 ? 'yellow' : ''}`}
                      onMouseEnter={(e) => handleBarHover(e, `$${item.cost}`, item.model)}
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
                {traces.slice(0, 5).map((trace) => (
                  <tr key={trace.id} onClick={() => { setSelectedTrace(trace); setDrawerOpen(true); }}>
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
                ))}
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
            {incidents.map((incident) => (
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
            ))}
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
            {expensiveWorkflows.map((flow) => (
              <tr key={flow.name}>
                <td className="code-font">{flow.name}</td>
                <td>{flow.calls.toLocaleString()}</td>
                <td>{flow.latency}</td>
                <td>{flow.avgCost}</td>
                <td style={{ fontWeight: '600' }}>{flow.totalCost}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
