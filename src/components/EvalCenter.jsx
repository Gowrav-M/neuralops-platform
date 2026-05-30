import { useEffect, useState } from 'react';
import { fetchEvals, fetchTraces, runEvals } from '../lib/api';

export default function EvalCenter({ addToast }) {
  const [selectedDataset, setSelectedDataset] = useState('backend_traces');
  const [activeEvaluator, setActiveEvaluator] = useState('pii_detector');

  const [evaluators, setEvaluators] = useState([]);
  const [datasets, setDatasets] = useState([]);
  const [comparisonRows, setComparisonRows] = useState([]);
  const [failedQueue, setFailedQueue] = useState([]);
  const [dataSource, setDataSource] = useState('loading');

  const comparisonMetrics = ['Eval Score', 'Answer Quality', 'Latency', 'Token Cost / 1k'];

  useEffect(() => {
    let cancelled = false;

    Promise.all([fetchEvals(), fetchTraces()])
      .then(([items, traces]) => {
        if (cancelled) return;
        setEvaluators(items.map((item) => ({
          id: item.id,
          name: item.name,
          status: item.status === 'failing' ? 'Failing' : item.status === 'warning' ? 'Warning' : 'Enabled',
          type: item.type,
          passRate: `${(item.passRate * 100).toFixed(1)}%`,
          testCount: item.testCount
        })));
        const nextDatasets = [...new Set(items.map((item) => item.dataset).filter(Boolean))];
        setDatasets(nextDatasets);
        setSelectedDataset(nextDatasets[0] || 'backend_traces');
        setActiveEvaluator(items[0]?.id || '');
        setFailedQueue(
          traces
            .filter((trace) => trace.status !== 'success' || trace.score < 0.8)
            .slice(0, 6)
            .map((trace) => ({
              id: `eval_${trace.id}`,
              timestamp: trace.timestamp,
              evaluator: trace.status === 'blocked' ? 'Policy Guard' : 'Quality Scorer',
              score: trace.score,
              reason: trace.status === 'blocked'
                ? `Blocked trace ${trace.id}: ${trace.prompt}`
                : `Low score trace ${trace.id} from ${trace.model}: ${trace.output}`
            }))
        );
        const grouped = traces.reduce((acc, trace) => {
          const current = acc.get(trace.model) || { model: trace.model, count: 0, score: 0, latency: 0, cost: 0, tokens: 0 };
          current.count += 1;
          current.score += trace.score;
          current.latency += Number.parseFloat(trace.latency.replace('s', '')) || 0;
          current.cost += Number.parseFloat(trace.cost.replace('$', '')) || 0;
          current.tokens += trace.tokens;
          acc.set(trace.model, current);
          return acc;
        }, new Map());
        setComparisonRows(
          [...grouped.values()].map((item) => ({
            name: item.model,
            scores: [
              (item.score / item.count).toFixed(2),
              (item.score / item.count).toFixed(2),
              `${(item.latency / item.count).toFixed(2)}s`,
              `$${((item.cost / Math.max(item.tokens, 1)) * 1000).toFixed(4)}`
            ]
          }))
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

  const handleRunEvaluation = async () => {
    try {
      const items = await runEvals();
      setEvaluators(items.map((item) => ({
        id: item.id,
        name: item.name,
        status: item.status === 'failing' ? 'Failing' : item.status === 'warning' ? 'Warning' : 'Enabled',
        type: item.type,
        passRate: `${(item.passRate * 100).toFixed(1)}%`,
        testCount: item.testCount
      })));
      addToast('Backend evaluation run completed and evaluator cards refreshed.', 'success');
    } catch {
      addToast('Backend unavailable. Evaluation run was not started.', 'error');
    }
  };

  return (
    <div className="main-panel">
      {/* Regression Detection Banner */}
      {failedQueue.length > 0 && (
      <div
        style={{
          background: 'var(--color-error-light)',
          border: '1.5px solid rgba(220, 90, 69, 0.2)',
          padding: '16px 20px',
          borderRadius: 'var(--radius-md)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          animation: 'pulse 2s infinite alternate'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-error)', flexShrink: 0 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" style={{ width: '22px', height: '22px' }}>
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
          </span>
          <div>
            <h4 style={{ color: 'var(--color-blocked)', fontSize: '13.5px', fontWeight: '600' }}>Backend Evaluation Issues Detected</h4>
            <p style={{ color: 'var(--text-primary)', fontSize: '12px', marginTop: '2px' }}>
              {failedQueue.length} backend trace evaluation issue{failedQueue.length === 1 ? '' : 's'} need review before promotion.
            </p>
          </div>
        </div>
      </div>
      )}

      {/* Page Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Evaluation Center</h1>
          <p className="page-subtitle">
            Configure automated test benches, LLM-as-a-judge criteria, and compare multi-model outputs.
            {dataSource === 'api' ? ' Backend connected.' : dataSource === 'fallback' ? ' Backend offline; no local samples shown.' : ' Loading backend data...'}
          </p>
        </div>
      </div>

      {/* Controls Bar */}
      <div className="filter-bar">
        <div className="filter-inputs-group">
          <span style={{ fontSize: '12px', fontWeight: 600 }}>Active Dataset:</span>
          <select
            className="filter-select"
            value={selectedDataset}
            onChange={(e) => setSelectedDataset(e.target.value)}
          >
            {datasets.length > 0 ? datasets.map((dataset) => (
              <option key={dataset} value={dataset}>{dataset}</option>
            )) : (
              <option value="backend_traces">backend_traces</option>
            )}
          </select>
        </div>

        <button className="btn-primary" onClick={handleRunEvaluation}>
          Run Dataset Test Suite
        </button>
      </div>

      {/* Evaluator Card Grid */}
      <div className="metrics-grid-row" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        {evaluators.map((ev) => (
          <div
            key={ev.id}
            className={`metric-card-square ${activeEvaluator === ev.id ? 'active' : ''}`}
            onClick={() => setActiveEvaluator(ev.id)}
            style={{ padding: '20px' }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="badge badge-success" style={{ fontSize: '8px' }}>{ev.status}</span>
              <span style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>{ev.type}</span>
            </div>
            <div style={{ marginTop: '8px' }}>
              <h4 style={{ fontSize: '15px', fontWeight: 600 }}>{ev.name}</h4>
              <p style={{ fontSize: '20px', fontWeight: 700, marginTop: '4px', color: 'var(--text-primary)' }}>
                {ev.passRate} <span style={{ fontSize: '11px', fontWeight: '500', color: 'var(--text-secondary)' }}>pass rate</span>
              </p>
            </div>
            <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '10px', marginTop: '4px', display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'var(--text-secondary)' }}>
              <span>Tests run: {ev.testCount}</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                Details
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: '10px', height: '10px' }}>
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              </span>
            </div>
          </div>
        ))}
        {evaluators.length === 0 && (
          <div className="metric-card-square" style={{ padding: '20px', gridColumn: '1 / -1' }}>
            <span className="metric-label">No Evaluators</span>
            <span style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>
              Add evaluator records through the backend before running a test suite.
            </span>
          </div>
        )}
      </div>

      {/* Main comparative grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: '24px' }}>
        {/* Model/Prompt Comparison Matrix */}
        <div className="table-container" style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <span style={{ fontSize: '15px', fontWeight: '600' }}>Model & Prompt Version Matrix</span>
          <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '-8px' }}>
            Comparing scores from the latest test bench runs against <strong>{selectedDataset}</strong>.
          </p>

          <table className="matrix-table">
            <thead>
              <tr>
                <th>Model / Prompt Version</th>
                {comparisonMetrics.map(m => <th key={m}>{m}</th>)}
              </tr>
            </thead>
            <tbody>
              {comparisonRows.map((model) => (
                <tr key={model.name}>
                  <td style={{ textAlign: 'left', fontWeight: '600', fontSize: '11px' }}>{model.name}</td>
                  {model.scores.map((score, index) => {
                    const isScore = !score.includes('s') && !score.includes('$');
                    const numScore = parseFloat(score);
                    let scoreClass = '';
                    if (isScore) {
                      scoreClass = numScore >= 0.9 ? 'high' : numScore >= 0.8 ? 'medium' : 'low';
                    }
                    return (
                      <td key={index} className={`matrix-cell-score ${scoreClass}`}>
                        {score}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {comparisonRows.length === 0 && (
                <tr>
                  <td colSpan={comparisonMetrics.length + 1} style={{ color: 'var(--text-secondary)' }}>
                    No backend traces are available for comparison yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Failed Evals Queue */}
        <div className="dark-panel-container">
          <div className="dark-panel-title-row">
            <span className="dark-panel-title">Failed Evaluation Review Queue</span>
            <span className="badge badge-error" style={{ fontSize: '10px' }}>{failedQueue.length} Failed</span>
          </div>

          <div className="dark-list">
            {failedQueue.length > 0 ? failedQueue.map((item) => (
              <div key={item.id} className="dark-list-item">
                <div className="item-left" style={{ alignItems: 'flex-start' }}>
                  <div className="item-icon-box" style={{ color: 'var(--color-error)', background: 'rgba(255,255,255,0.05)', flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: '12px', height: '12px' }}>
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </div>
                  <div className="item-meta">
                    <span className="item-title" style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                      {item.evaluator}
                      <span style={{ fontSize: '9px', background: 'rgba(255,255,255,0.1)', padding: '1px 4px', borderRadius: '4px', color: 'rgba(255,255,255,0.6)' }}>
                        Score: {item.score}
                      </span>
                    </span>
                    <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.6)', lineHeight: '1.4', marginTop: '4px' }}>
                      {item.reason}
                    </p>
                    <span className="item-subtitle" style={{ marginTop: '4px' }}>Logged: {item.timestamp}</span>
                  </div>
                </div>
              </div>
            )) : (
              <div className="dark-list-item">
                <div className="item-meta">
                  <span className="item-title">No failed evaluations</span>
                  <span className="item-subtitle">No failing backend trace records are available.</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
