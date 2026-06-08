import { useEffect, useState } from 'react';
import { fetchProductionReadiness } from '../lib/api';

function badgeClass(state) {
  if (state === 'pass') return 'badge-success';
  if (state === 'block') return 'badge-error';
  return 'badge-warning';
}

export default function ProductionReadiness({ addToast }) {
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true);
    setError('');
    try {
      const nextReport = await fetchProductionReadiness();
      setReport(nextReport);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Production readiness unavailable');
      addToast('Production readiness check failed.', 'error');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    fetchProductionReadiness()
      .then((nextReport) => {
        if (!cancelled) setReport(nextReport);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Production readiness unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="main-panel">
      <div className="page-header">
        <div>
          <h1 className="page-title">Production Readiness</h1>
          <p className="page-subtitle">
            A deploy gate for the SaaS itself: auth, workspace isolation, RBAC, database, gateway, provider, and audit state are checked from the backend.
          </p>
        </div>
        <button className="btn-primary" onClick={load} disabled={busy}>
          Run Readiness Check
        </button>
      </div>

      {error && (
        <div className="state-container" style={{ alignItems: 'flex-start', textAlign: 'left' }}>
          <strong>Readiness unavailable</strong>
          <span>{error}</span>
        </div>
      )}

      <div className="summary-grid">
        <div className="stat-card highlight">
          <span className="stat-label">Decision</span>
          <strong className="stat-value">{report?.decision?.toUpperCase() || 'LOADING'}</strong>
          <span className="stat-trend positive">backend-generated deployment gate</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Score</span>
          <strong className="stat-value">{report ? `${report.score}/100` : '0/100'}</strong>
          <span className="stat-trend positive">truthful readiness score</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Workspace</span>
          <strong className="stat-value">{report?.workspaceId || 'loading'}</strong>
          <span className="stat-trend positive">active tenant boundary</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Blockers</span>
          <strong className="stat-value">{report?.blockers?.length || 0}</strong>
          <span className="stat-trend positive">must be zero before public launch</span>
        </div>
      </div>

      <div className="content-grid two-col">
        <div className="card-container">
          <div className="section-header">
            <div>
              <h3>Deployment Checks</h3>
              <p>Each check is computed from real backend state, not static copy.</p>
            </div>
          </div>
          <div className="event-list">
            {(report?.checks || []).map((check) => (
              <div className="event-row" key={check.id}>
                <span className={`badge ${badgeClass(check.state)}`}>{check.state}</span>
                <div>
                  <strong>{check.label}</strong>
                  <p>{check.detail}</p>
                </div>
                <span className="mono-text">{check.id}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="dark-panel-container">
          <div className="section-header">
            <div>
              <h3>Launch Rule</h3>
              <p>Public deployment should proceed only when this page returns ALLOW.</p>
            </div>
            {report && <span className={`badge ${badgeClass(report.decision === 'allow' ? 'pass' : report.decision)}`}>{report.decision}</span>}
          </div>
          <div className="evidence-card">
            <span className="meta-label">Operator guidance</span>
            <h3>{report?.decision === 'allow' ? 'Ready for production smoke test' : 'Review deployment blockers first'}</h3>
            <p>
              Use this report before Vercel/Render release. It validates whether authentication, tenant isolation, RBAC, database storage, gateway policy, and audit evidence are actually configured.
            </p>
          </div>
          {report?.blockers?.length > 0 && (
            <div className="event-list">
              {report.blockers.map((blocker) => (
                <div className="event-row" key={blocker}>
                  <span className="badge badge-error">block</span>
                  <div>
                    <strong>Launch blocker</strong>
                    <p>{blocker}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
