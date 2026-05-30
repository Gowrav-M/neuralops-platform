import { useEffect, useState } from 'react';
import { fetchCosts, fetchTraces } from '../lib/api';

export default function CostDashboard() {
  const [budgetLimit, setBudgetLimit] = useState(5000);
  const [mtdSpend, setMtdSpend] = useState(0);
  const [projectedSpend, setProjectedSpend] = useState(0);
  const [costPerThousand, setCostPerThousand] = useState(0);
  const [dataSource, setDataSource] = useState('loading');

  const [costByModel, setCostByModel] = useState([]);

  const [costByFeature, setCostByFeature] = useState([]);

  const [topExpensiveTraces, setTopExpensiveTraces] = useState([]);

  useEffect(() => {
    let cancelled = false;

    Promise.all([fetchCosts(), fetchTraces()])
      .then(([payload, traces]) => {
        if (cancelled) return;
        const traceSpend = traces.reduce((sum, trace) => sum + (Number.parseFloat(String(trace.cost).replace('$', '')) || 0), 0);
        const traceTokens = traces.reduce((sum, trace) => sum + (trace.tokens || 0), 0);
        const byModel = [...traces.reduce((acc, trace) => {
          const cost = Number.parseFloat(String(trace.cost).replace('$', '')) || 0;
          acc.set(trace.model, (acc.get(trace.model) || 0) + cost);
          return acc;
        }, new Map()).entries()].map(([model, spend]) => ({ model, spend }));
        const byFeature = [...traces.reduce((acc, trace) => {
          const feature = trace.toolCalls || trace.session || 'direct_model_call';
          const cost = Number.parseFloat(String(trace.cost).replace('$', '')) || 0;
          acc.set(feature, (acc.get(feature) || 0) + cost);
          return acc;
        }, new Map()).entries()].map(([feature, spend]) => ({ feature, spend }));

        setMtdSpend(payload.summary?.mtdSpend ?? traceSpend);
        setBudgetLimit(payload.summary?.budgetLimit ?? 5000);
        setProjectedSpend(payload.summary?.projectedSpend ?? traceSpend);
        setCostPerThousand(payload.summary?.costPerThousand ?? (traceTokens > 0 ? (traceSpend / traceTokens) * 1000 : 0));
        setCostByModel(payload.byModel ?? byModel);
        setCostByFeature(payload.byFeature ?? byFeature);
        setTopExpensiveTraces(
          traces
            .map((trace) => ({
              id: trace.id,
              model: trace.model,
              tokens: trace.tokens,
              cost: trace.cost,
              user: trace.session,
              latency: trace.latency
            }))
            .sort((a, b) => (Number.parseFloat(b.cost.replace('$', '')) || 0) - (Number.parseFloat(a.cost.replace('$', '')) || 0))
            .slice(0, 6)
        );
        setDataSource('api');
      })
      .catch(() => {
        if (cancelled) return;
        setDataSource('fallback');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const getPercentBudget = () => {
    return Math.min(100, Math.round((mtdSpend / budgetLimit) * 100));
  };
  const maxModelSpend = Math.max(...costByModel.map((item) => item.spend), 0.001);
  const maxFeatureSpend = Math.max(...costByFeature.map((item) => item.spend), 0.001);

  return (
    <div className="main-panel">
      {/* Page Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Cost & Budgets</h1>
          <p className="page-subtitle">
            Track spending from real ingested traces and persisted backend cost records.
            {dataSource === 'api' ? ' Backend connected.' : dataSource === 'fallback' ? ' Backend offline; no local samples shown.' : ' Loading backend data...'}
          </p>
        </div>
      </div>

      {/* Top row controls */}
      <div className="filter-bar">
        <div className="filter-inputs-group">
          <span style={{ fontSize: '12px', fontWeight: 600 }}>Configure Monthly Budget Limit:</span>
          <select
            className="filter-select"
            value={budgetLimit}
            onChange={(e) => setBudgetLimit(parseInt(e.target.value))}
          >
            <option value="4000">$4,000 / month</option>
            <option value="5000">$5,000 / month</option>
            <option value="8000">$8,000 / month</option>
          </select>
        </div>
      </div>

      {/* Metrics Row */}
      <div className="metrics-grid-row" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <div className="metric-card-square">
          <span className="metric-label">Month-to-Date Spend</span>
          <span className="metric-value">${mtdSpend.toLocaleString()}</span>
          <span className="metric-trend up">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M1 9L9 1M9 1H3M9 1V7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            from backend records
          </span>
        </div>
        <div className="metric-card-square">
          <span className="metric-label">Projected Spend</span>
          <span className="metric-value">${Math.round(projectedSpend).toLocaleString()}</span>
          <span className="metric-trend up">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M1 9L9 1M9 1H3M9 1V7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            current projection
          </span>
        </div>
        <div className="metric-card-square">
          <span className="metric-label">Budget Consumption</span>
          <span className="metric-value">{getPercentBudget()}%</span>
          <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>of ${budgetLimit.toLocaleString()} limit</span>
        </div>
        <div className="metric-card-square">
          <span className="metric-label">Cost per 1k Interactions</span>
          <span className="metric-value">${costPerThousand.toFixed(2)}</span>
          <span className="metric-trend down">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M1 1L9 9M9 9H3M9 9V3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            from backend records
          </span>
        </div>
      </div>

      {/* Budget consumption progress bar */}
      <div className="card-container" style={{ gap: '10px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', fontWeight: 600 }}>
          <span>Budget Burn Rate (MTD Spend vs Limit)</span>
          <span>${mtdSpend.toLocaleString()} / ${budgetLimit.toLocaleString()}</span>
        </div>
        <div className="slider-metric-bar" style={{ width: '100%', height: '14px', borderRadius: '7px' }}>
          <div
            className="slider-metric-fill yellow"
            style={{ width: `${getPercentBudget()}%`, borderRadius: '7px', transition: 'width 0.4s ease' }}
          ></div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px' }}>
          {getPercentBudget() >= 80 ? (
            <>
              <svg viewBox="0 0 24 24" fill="none" stroke="var(--color-warning)" strokeWidth="2.5" style={{ width: '13px', height: '13px', flexShrink: 0 }}>
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <span>You are approaching your configured monthly budget. Alert triggers configured at 90%.</span>
            </>
          ) : (
            <>
              <svg viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" strokeWidth="2.5" style={{ width: '13px', height: '13px', flexShrink: 0 }}>
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
              <span>Burn rate normal. You are projected to clear the billing period within limits.</span>
            </>
          )}
        </div>
      </div>

      {/* Charts: Cost breakdown by Model and Feature */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
        {/* Cost by Model SVG bar chart */}
        <div className="card-container">
          <span className="card-title">Accumulated Spend by Model</span>

          <div className="chart-container-inner" style={{ height: '160px', marginTop: '10px' }}>
            <svg className="chart-svg-box" viewBox="0 0 400 130">
              <line x1="20" y1="120" x2="380" y2="120" className="chart-axis-line" />
            {costByModel.length > 0 ? costByModel.map((item, index) => {
                const barWidth = 45;
                const gap = 38;
                const x = 36 + index * (barWidth + gap);
                const height = Math.max(4, (item.spend / maxModelSpend) * 100);
                const y = 120 - height;
                return (
                  <g key={item.model}>
                    <rect x={x} y={y} width={barWidth} height={height} className="chart-bar yellow" />
                    <text
                      x={x + barWidth/2}
                      y="132"
                      textAnchor="middle"
                      style={{ fontSize: '8px', fill: 'var(--text-secondary)', fontFamily: 'var(--font-sans)' }}
                    >
                      {item.model.replace('claude-3.5-', '').replace('gpt-4o-', '')}
                    </text>
                  </g>
                );
              }) : (
                <text x="200" y="70" textAnchor="middle" style={{ fontSize: '11px', fill: 'var(--text-secondary)', fontFamily: 'var(--font-sans)' }}>
                  No backend model spend records
                </text>
              )}
            </svg>
          </div>
        </div>

        {/* Cost by Feature SVG bar chart */}
        <div className="card-container">
          <span className="card-title">Accumulated Spend by Feature Operations</span>

          <div className="chart-container-inner" style={{ height: '160px', marginTop: '10px' }}>
            <svg className="chart-svg-box" viewBox="0 0 400 130">
              <line x1="20" y1="120" x2="380" y2="120" className="chart-axis-line" />
            {costByFeature.length > 0 ? costByFeature.map((item, index) => {
                const barWidth = 45;
                const gap = 38;
                const x = 36 + index * (barWidth + gap);
                const height = Math.max(4, (item.spend / maxFeatureSpend) * 100);
                const y = 120 - height;
                return (
                  <g key={item.feature}>
                    <rect x={x} y={y} width={barWidth} height={height} className="chart-bar" />
                    <text
                      x={x + barWidth/2}
                      y="132"
                      textAnchor="middle"
                      style={{ fontSize: '8.5px', fill: 'var(--text-secondary)', fontFamily: 'var(--font-sans)' }}
                    >
                      {item.feature.substring(0, 10) + '...'}
                    </text>
                  </g>
                );
              }) : (
                <text x="200" y="70" textAnchor="middle" style={{ fontSize: '11px', fill: 'var(--text-secondary)', fontFamily: 'var(--font-sans)' }}>
                  No backend feature spend records
                </text>
              )}
            </svg>
          </div>
        </div>
      </div>

      {/* Top Expensive Traces Table */}
      <div className="table-container" style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <span style={{ fontSize: '15px', fontWeight: '600' }}>Top Expensive Trace Invocations</span>

        <table className="dense-table">
          <thead>
            <tr>
              <th>Trace ID</th>
              <th>Model Name</th>
              <th>Total Tokens</th>
              <th>Latency</th>
              <th>User Workspace</th>
              <th>Total Cost</th>
            </tr>
          </thead>
          <tbody>
            {topExpensiveTraces.length > 0 ? topExpensiveTraces.map((trace, index) => (
              <tr key={`${trace.id}-${index}`}>
                <td className="code-font">{trace.id}</td>
                <td className="code-font" style={{ fontWeight: 500 }}>{trace.model}</td>
                <td>{trace.tokens.toLocaleString()}</td>
                <td>{trace.latency}</td>
                <td>{trace.user}</td>
                <td style={{ fontWeight: '600' }}>{trace.cost}</td>
              </tr>
            )) : (
              <tr>
                <td colSpan="6" style={{ color: 'var(--text-secondary)' }}>No backend traces are available yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
