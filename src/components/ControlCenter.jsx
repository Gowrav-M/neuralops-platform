import { useEffect, useMemo, useState } from 'react';
import { exportControlCenter, fetchControlCenter } from '../lib/api';

const statusClass = {
  pass: 'badge-success',
  review: 'badge-warning',
  block: 'badge-error',
};

const domainLabels = {
  governance: 'Governance',
  security: 'Security',
  reliability: 'Reliability',
  operations: 'Operations',
  cost: 'Cost',
  access: 'Access',
};

export default function ControlCenter({ addToast }) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [domain, setDomain] = useState('all');

  const controls = useMemo(() => report?.controls || [], [report]);
  const filtered = useMemo(
    () => controls.filter((control) => domain === 'all' || control.domain === domain),
    [controls, domain],
  );
  const selected = controls.find((control) => control.id === selectedId) || filtered[0] || controls[0] || null;
  const domains = useMemo(() => Array.from(new Set(controls.map((control) => control.domain))), [controls]);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const next = await fetchControlCenter();
      setReport(next);
      setSelectedId((current) => current && next.controls.some((control) => control.id === current) ? current : next.controls[0]?.id || null);
    } catch (err) {
      setError(err.message || 'Failed to load Control Center.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(load, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const handleExport = async () => {
    try {
      const exported = await exportControlCenter();
      addToast?.(`Control evidence exported: ${exported.id}`, 'success');
      await load();
    } catch (err) {
      addToast?.(err.message || 'Control export failed.', 'error');
    }
  };

  if (loading) {
    return (
      <div className="estate-empty-state">
        <div className="spinner" />
        <h1 className="page-title">Control Center</h1>
        <p className="section-subtitle">Mapping persisted NeuralOps evidence to enterprise controls.</p>
      </div>
    );
  }

  const summary = report?.summary || {};

  return (
    <div className="control-center-page">
      <div className="page-intro control-hero">
        <div>
          <span className="badge badge-success">Audit-Ready Evidence Matrix</span>
          <h1 className="page-title">Control Center</h1>
          <p className="section-subtitle">
            Map traces, release gates, SLOs, gateway routes, estate ownership, access audit, incidents, costs, and risk exceptions into one control report.
          </p>
        </div>
        <div className="button-cluster">
          <button className="btn-secondary" onClick={load}>Refresh</button>
          <button className="btn-primary" onClick={handleExport}>Export Evidence</button>
        </div>
      </div>

      {error && (
        <div className="alert-banner alert-error">
          <strong>Control Center unavailable</strong>
          <span>{error}</span>
        </div>
      )}

      <section className="control-summary-grid" aria-label="Control center summary">
        <div className="control-score-card">
          <span>Coverage</span>
          <strong>{summary.coverageScore ?? 0}/100</strong>
          <small>{summary.total || 0} mapped control(s)</small>
        </div>
        <div>
          <span>Passing</span>
          <strong>{summary.passing || 0}</strong>
        </div>
        <div>
          <span>Review</span>
          <strong>{summary.review || 0}</strong>
        </div>
        <div>
          <span>Blocked</span>
          <strong>{summary.blocked || 0}</strong>
        </div>
      </section>

      <div className="control-filter-bar">
        <span>Domain</span>
        <div className="segmented-control">
          <button className={domain === 'all' ? 'active' : ''} onClick={() => setDomain('all')}>All</button>
          {domains.map((item) => (
            <button className={domain === item ? 'active' : ''} key={item} onClick={() => setDomain(item)}>
              {domainLabels[item] || item}
            </button>
          ))}
        </div>
      </div>

      <section className="control-layout">
        <div className="control-matrix card-container">
          <div className="section-header">
            <div>
              <h3>Control Matrix</h3>
              <p>Each row is generated from persisted backend evidence, not a manual checklist.</p>
            </div>
          </div>
          <div className="control-row-stack">
            {filtered.map((control) => (
              <button
                className={`control-row ${selected?.id === control.id ? 'active' : ''}`}
                key={control.id}
                onClick={() => setSelectedId(control.id)}
              >
                <span className={`badge ${statusClass[control.status] || 'badge-warning'}`}>{control.status}</span>
                <strong>{control.title}</strong>
                <small>{domainLabels[control.domain] || control.domain} | {control.owner}</small>
              </button>
            ))}
          </div>
        </div>

        <aside className="control-detail card-container" aria-label="Selected control detail">
          {selected && (
            <>
              <div className="control-detail-head">
                <span className={`badge ${statusClass[selected.status] || 'badge-warning'}`}>{selected.status}</span>
                <h3>{selected.title}</h3>
                <p>{selected.requirement}</p>
              </div>

              <div className="control-detail-grid">
                <div>
                  <span>Domain</span>
                  <strong>{domainLabels[selected.domain] || selected.domain}</strong>
                </div>
                <div>
                  <span>Owner</span>
                  <strong>{selected.owner}</strong>
                </div>
              </div>

              <div className="control-evidence-list">
                <span>Evidence</span>
                {selected.evidence.map((entry) => (
                  <div className="control-evidence-item" key={entry.id}>
                    <strong>{entry.label}</strong>
                    <small>{entry.detail}</small>
                  </div>
                ))}
              </div>

              <div className="control-gap-list">
                <span>Gaps</span>
                {(selected.gaps.length ? selected.gaps : ['No active gaps for this control.']).map((gap) => (
                  <p key={gap}>{gap}</p>
                ))}
              </div>

              <div className="control-framework-list">
                <span>Mapped Frameworks</span>
                <div>
                  {selected.mappedFrameworks.map((framework) => (
                    <span className="badge badge-neutral" key={framework}>{framework}</span>
                  ))}
                </div>
              </div>

              <div className="action-explain-block">
                <span>Next Step</span>
                <p>{selected.nextStep}</p>
              </div>
            </>
          )}
        </aside>
      </section>
    </div>
  );
}
