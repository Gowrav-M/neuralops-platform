import { useEffect, useState } from 'react';
import { fetchCosts, simulateCostAnomaly } from '../lib/api';

const FALLBACK_COST_BY_MODEL = [
  { model: 'claude-3.5-sonnet', spend: 1850 },
  { model: 'gpt-4o', spend: 1100 },
  { model: 'llama-3.1-70b', spend: 320 },
  { model: 'gpt-4o-mini', spend: 180.40 }
];

const FALLBACK_COST_BY_FEATURE = [
  { feature: 'customer_support_bot', spend: 1450 },
  { feature: 'rag_data_ingest', spend: 950 },
  { feature: 'internal_dev_copilot', spend: 650 },
  { feature: 'pii_pre_filter', spend: 400.40 }
];

export default function CostDashboard({ addToast }) {
  const [anomalyTriggered, setAnomalyTriggered] = useState(false);
  const [budgetLimit, setBudgetLimit] = useState(5000);
  const [mtdSpend, setMtdSpend] = useState(3450.40);
  const [dataSource, setDataSource] = useState('loading');

  const [costByModel, setCostByModel] = useState(FALLBACK_COST_BY_MODEL);

  const [costByFeature, setCostByFeature] = useState(FALLBACK_COST_BY_FEATURE);

  const topExpensiveTraces = [
    { id: 'tr_expensive_01', model: 'claude-3.5-sonnet', tokens: 145000, cost: '$4.35', user: 'corp_client_intel', latency: '4.80s' },
    { id: 'tr_expensive_02', model: 'gpt-4o', tokens: 92000, cost: '$2.76', user: 'marketing_copy_gen', latency: '3.12s' },
    { id: 'tr_expensive_03', model: 'claude-3.5-sonnet', tokens: 81000, cost: '$2.43', user: 'legal_doc_parser', latency: '5.20s' },
    { id: 'tr_expensive_04', model: 'nvidia-nim-qwen3-coder', tokens: 120000, cost: '$1.80', user: 'developer_sandbox', latency: '2.50s' }
  ];

  useEffect(() => {
    let cancelled = false;

    fetchCosts()
      .then((payload) => {
        if (cancelled) return;
        setMtdSpend(payload.summary?.mtdSpend ?? 3450.40);
        setBudgetLimit(payload.summary?.budgetLimit ?? 5000);
        setCostByModel(payload.byModel ?? FALLBACK_COST_BY_MODEL);
        setCostByFeature(payload.byFeature ?? FALLBACK_COST_BY_FEATURE);
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

  const handleSimulateAnomaly = async () => {
    setAnomalyTriggered(true);
    try {
      const result = await simulateCostAnomaly();
      if (result.summary?.mtdSpend) {
        setMtdSpend(result.summary.mtdSpend);
      }
      addToast('CRITICAL ALERT: Backend recorded cost spike in customer_support_bot ($120.40/min vs standard $2.50/min)!', 'error');
    } catch {
      addToast('CRITICAL ALERT: Local fallback cost spike simulation triggered while backend is offline.', 'error');
    }
  };

  const getPercentBudget = () => {
    return Math.min(100, Math.round((mtdSpend / budgetLimit) * 100));
  };

  return (
    <div className="main-panel">
      {/* Spend Anomaly Banner */}
      {anomalyTriggered && (
        <div 
          style={{ 
            background: 'var(--color-error-light)', 
            border: '1.5px solid rgba(220, 90, 69, 0.2)', 
            padding: '16px 20px', 
            borderRadius: 'var(--radius-md)', 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: '22px', height: '22px', color: 'var(--color-error)', flexShrink: 0 }}>
              <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <div>
              <h4 style={{ color: 'var(--color-blocked)', fontSize: '13.5px', fontWeight: '600' }}>Cost Anomaly Alert Triggered</h4>
              <p style={{ color: 'var(--text-primary)', fontSize: '12px', marginTop: '2px' }}>
                Operational spending spiked +450% over the last 15 minutes in <strong>prod_rag_qa</strong> workspace.
              </p>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button 
              className="btn-primary" 
              style={{ background: 'var(--color-blocked)', padding: '6px 12px', fontSize: '11px' }}
              onClick={() => {
                setAnomalyTriggered(false);
                addToast('Spend anomaly resolved. Active rate limit applied to offending workspace.', 'success');
              }}
            >
              Acknowledge & Restrict Rate
            </button>
          </div>
        </div>
      )}

      {/* Page Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Cost & Budgets</h1>
          <p className="page-subtitle">
            Track month-to-date spending patterns, analyze costs per feature, and simulate anomaly limits.
            {dataSource === 'api' ? ' Backend data loaded.' : dataSource === 'fallback' ? ' Offline fallback active.' : ' Loading backend data...'}
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

        <button className="btn-secondary" style={{ color: 'var(--color-error)' }} onClick={handleSimulateAnomaly}>
          Simulate Spend Spike Anomaly
        </button>
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
            +18.5%
          </span>
        </div>
        <div className="metric-card-square">
          <span className="metric-label">Projected Spend</span>
          <span className="metric-value">${Math.round(mtdSpend * 1.15).toLocaleString()}</span>
          <span className="metric-trend up">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M1 9L9 1M9 1H3M9 1V7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            +12.0%
          </span>
        </div>
        <div className="metric-card-square">
          <span className="metric-label">Budget Consumption</span>
          <span className="metric-value">{getPercentBudget()}%</span>
          <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>of ${budgetLimit.toLocaleString()} limit</span>
        </div>
        <div className="metric-card-square">
          <span className="metric-label">Cost per 1k Interactions</span>
          <span className="metric-value">$0.42</span>
          <span className="metric-trend down">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M1 1L9 9M9 9H3M9 9V3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            -8.4%
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
              {costByModel.map((item, index) => {
                const barWidth = 45;
                const gap = 38;
                const x = 36 + index * (barWidth + gap);
                const maxSpend = 2000;
                const height = (item.spend / maxSpend) * 100;
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
              })}
            </svg>
          </div>
        </div>

        {/* Cost by Feature SVG bar chart */}
        <div className="card-container">
          <span className="card-title">Accumulated Spend by Feature Operations</span>
          
          <div className="chart-container-inner" style={{ height: '160px', marginTop: '10px' }}>
            <svg className="chart-svg-box" viewBox="0 0 400 130">
              <line x1="20" y1="120" x2="380" y2="120" className="chart-axis-line" />
              {costByFeature.map((item, index) => {
                const barWidth = 45;
                const gap = 38;
                const x = 36 + index * (barWidth + gap);
                const maxSpend = 1600;
                const height = (item.spend / maxSpend) * 100;
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
              })}
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
            {topExpensiveTraces.map((trace) => (
              <tr key={trace.id}>
                <td className="code-font">{trace.id}</td>
                <td className="code-font" style={{ fontWeight: 500 }}>{trace.model}</td>
                <td>{trace.tokens.toLocaleString()}</td>
                <td>{trace.latency}</td>
                <td>{trace.user}</td>
                <td style={{ fontWeight: '600' }}>{trace.cost}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
