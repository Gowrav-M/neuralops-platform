import { useEffect, useMemo, useState } from 'react';
import { fetchActionCenter } from '../lib/api';

const severityClass = {
  critical: 'badge-error',
  high: 'badge-warning',
  medium: 'badge-warning',
  low: 'badge-success',
};

const categoryLabels = {
  connect: 'Connect',
  govern: 'Govern',
  operate: 'Operate',
  secure: 'Secure',
  release: 'Release',
  cost: 'Cost',
};

function groupByCategory(items) {
  return items.reduce((groups, item) => {
    const key = item.category || 'operate';
    return { ...groups, [key]: [...(groups[key] || []), item] };
  }, {});
}

export default function ActionCenter({ setActiveTab, addToast }) {
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState(null);

  const items = useMemo(() => payload?.items || [], [payload]);
  const grouped = useMemo(() => groupByCategory(items), [items]);
  const selected = items.find((item) => item.id === selectedId) || items[0] || null;

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const next = await fetchActionCenter();
      setPayload(next);
      setSelectedId((current) => current && next.items.some((item) => item.id === current) ? current : next.items[0]?.id || null);
    } catch (err) {
      setError(err.message || 'Failed to load action center.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const handleOpen = (tab) => {
    if (!tab) return;
    setActiveTab?.(tab);
    addToast?.(`Opened ${tab} for the selected action.`, 'success');
  };

  if (loading) {
    return (
      <div className="estate-empty-state">
        <div className="spinner" />
        <h1 className="page-title">Action Center</h1>
        <p className="section-subtitle">Synthesizing the operator queue from backend evidence.</p>
      </div>
    );
  }

  const summary = payload?.summary || {};

  return (
    <div className="action-center-page">
      <div className="page-intro action-hero">
        <div>
          <span className="badge badge-success">Evidence-Driven Command Queue</span>
          <h1 className="page-title">Action Center</h1>
          <p className="section-subtitle">
            Prioritized next actions across readiness, SLOs, release gates, estate risk, incidents, detection, gateway, and setup truth.
          </p>
        </div>
        <div className="button-cluster">
          <button className="btn-secondary" onClick={load}>Refresh</button>
          <button className="btn-primary" onClick={() => handleOpen(selected?.destinationTab)} disabled={!selected}>
            Open Selected Surface
          </button>
        </div>
      </div>

      {error && (
        <div className="alert-banner alert-error">
          <strong>Action queue unavailable</strong>
          <span>{error}</span>
        </div>
      )}

      <section className="action-command-strip" aria-label="Action center summary">
        <div className="action-score-card">
          <span>Readiness</span>
          <strong>{summary.readinessScore ?? 0}/100</strong>
          <small>{summary.total || 0} open action(s)</small>
        </div>
        <div className="action-priority-rail">
          <div>
            <span>Critical</span>
            <strong>{summary.critical || 0}</strong>
          </div>
          <div>
            <span>High</span>
            <strong>{summary.high || 0}</strong>
          </div>
          <div>
            <span>Medium</span>
            <strong>{summary.medium || 0}</strong>
          </div>
          <div>
            <span>Low</span>
            <strong>{summary.low || 0}</strong>
          </div>
        </div>
        <div className="action-brief-panel">
          {(payload?.executiveBrief || []).map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      </section>

      {items.length === 0 ? (
        <div className="estate-empty-state card-container">
          <span className="badge badge-success">No open actions</span>
          <h3>NeuralOps does not see any immediate operator work.</h3>
          <p>Keep routing traffic and running gates so this queue stays evidence-backed.</p>
        </div>
      ) : (
        <section className="action-layout">
          <div className="action-queue card-container">
            <div className="section-header">
              <div>
                <h3>Prioritized Queue</h3>
                <p>Sorted by severity, then product area. Each item links to the page where the work should happen.</p>
              </div>
            </div>
            <div className="action-category-stack">
              {Object.entries(grouped).map(([category, group]) => (
                <div className="action-category" key={category}>
                  <div className="action-category-title">
                    <span>{categoryLabels[category] || category}</span>
                    <small>{group.length} item(s)</small>
                  </div>
                  {group.map((item) => (
                    <button
                      className={`action-row ${selected?.id === item.id ? 'active' : ''}`}
                      key={item.id}
                      onClick={() => setSelectedId(item.id)}
                    >
                      <span className={`badge ${severityClass[item.severity] || 'badge-success'}`}>{item.severity}</span>
                      <strong>{item.title}</strong>
                      <small>{item.owner} | {item.destinationTab}</small>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>

          <aside className="action-detail card-container" aria-label="Selected action detail">
            {selected && (
              <>
                <span className={`badge ${severityClass[selected.severity] || 'badge-success'}`}>{selected.severity}</span>
                <h3>{selected.title}</h3>
                <div className="action-detail-grid">
                  <div>
                    <span>Owner</span>
                    <strong>{selected.owner}</strong>
                  </div>
                  <div>
                    <span>Category</span>
                    <strong>{categoryLabels[selected.category] || selected.category}</strong>
                  </div>
                  <div>
                    <span>Source</span>
                    <strong>{selected.source}</strong>
                  </div>
                  <div>
                    <span>Surface</span>
                    <strong>{selected.destinationTab}</strong>
                  </div>
                </div>
                <div className="action-explain-block">
                  <span>Impact</span>
                  <p>{selected.impact}</p>
                </div>
                <div className="action-explain-block">
                  <span>Evidence</span>
                  <p>{selected.evidence}</p>
                </div>
                <div className="action-explain-block">
                  <span>Next Step</span>
                  <p>{selected.nextStep}</p>
                </div>
                <button className="btn-primary full-width" onClick={() => handleOpen(selected.destinationTab)}>
                  Open {selected.destinationTab}
                </button>
              </>
            )}
          </aside>
        </section>
      )}
    </div>
  );
}
