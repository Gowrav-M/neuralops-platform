import { useEffect, useState } from 'react';
import { createRiskException, fetchRiskExceptions, revokeRiskException } from '../lib/api';

const DEFAULT_FORM = {
  title: 'Temporary release exception for provider readiness',
  scope: 'release',
  sourceId: '',
  severity: 'Major',
  owner: 'AI Platform Owner',
  approver: 'Security Reviewer',
  reason: 'Business-critical release requires a time-boxed exception while compensating controls are active.',
  compensatingControls: 'Manual review before deploy\nRun release gate daily\nMonitor Action Center',
  expiresInDays: 14,
};

const statusClass = {
  active: 'badge-warning',
  expired: 'badge-error',
  revoked: 'badge-success',
};

const severityClass = {
  Critical: 'badge-error',
  Major: 'badge-warning',
  Minor: 'badge-warning',
  Low: 'badge-success',
};

function daysUntil(value) {
  const delta = new Date(value).getTime() - Date.now();
  return Math.ceil(delta / (1000 * 60 * 60 * 24));
}

export default function RiskRegister({ addToast }) {
  const [register, setRegister] = useState({ summary: {}, exceptions: [] });
  const [form, setForm] = useState(DEFAULT_FORM);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const payload = await fetchRiskExceptions();
      setRegister(payload);
    } catch (err) {
      setError(err.message || 'Risk register unavailable.');
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

  const updateForm = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const handleCreate = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const created = await createRiskException({
        ...form,
        expiresInDays: Number(form.expiresInDays),
        compensatingControls: form.compensatingControls
          .split('\n')
          .map((item) => item.trim())
          .filter(Boolean),
      });
      await load();
      addToast?.(`Risk exception created: ${created.title}.`, 'warning');
    } catch (err) {
      setError(err.message || 'Failed to create risk exception.');
    } finally {
      setBusy(false);
    }
  };

  const handleRevoke = async (exceptionId) => {
    setBusy(true);
    setError('');
    try {
      const revoked = await revokeRiskException(exceptionId);
      await load();
      addToast?.(`Risk exception revoked: ${revoked.title}.`, 'success');
    } catch (err) {
      setError(err.message || 'Failed to revoke risk exception.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="estate-empty-state">
        <div className="spinner" />
        <h1 className="page-title">Risk Register</h1>
        <p className="section-subtitle">Loading accepted-risk evidence from the backend.</p>
      </div>
    );
  }

  const summary = register.summary || {};

  return (
    <div className="risk-register-page">
      <div className="page-intro risk-hero">
        <div>
          <span className="badge badge-warning">Governance Workflow</span>
          <h1 className="page-title">Risk Register</h1>
          <p className="section-subtitle">
            Time-boxed approval records for accepted AI release, SLO, gateway, estate, detection, and policy risk.
          </p>
        </div>
        <div className="button-cluster">
          <button className="btn-secondary" onClick={load} disabled={busy}>Refresh</button>
        </div>
      </div>

      {error && (
        <div className="alert-banner alert-error">
          <strong>Risk register unavailable</strong>
          <span>{error}</span>
        </div>
      )}

      <section className="summary-grid risk-summary-grid" aria-label="Risk register summary">
        <div className="stat-card highlight">
          <span className="stat-label">Active Exceptions</span>
          <span className="stat-value">{summary.active || 0}</span>
          <span className="stat-trend">accepted risk</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Critical Active</span>
          <span className="stat-value">{summary.criticalActive || 0}</span>
          <span className="stat-trend negative">requires review</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Expiring Soon</span>
          <span className="stat-value">{summary.expiringSoon || 0}</span>
          <span className="stat-trend">within 7 days</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Expired</span>
          <span className="stat-value">{summary.expired || 0}</span>
          <span className="stat-trend negative">renewal needed</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Revoked</span>
          <span className="stat-value">{summary.revoked || 0}</span>
          <span className="stat-trend positive">closed risk</span>
        </div>
      </section>

      <section className="risk-layout">
        <form className="card-container risk-form" onSubmit={handleCreate}>
          <div className="section-header">
            <div>
              <h3>Create Risk Exception</h3>
              <p>Accepted risk must be specific, owned, approved, controlled, and time-boxed.</p>
            </div>
          </div>
          <label>
            <span className="metric-label">Title</span>
            <input className="filter-search-input" value={form.title} onChange={(event) => updateForm('title', event.target.value)} />
          </label>
          <div className="risk-form-grid">
            <label>
              <span className="metric-label">Scope</span>
              <select className="filter-select" value={form.scope} onChange={(event) => updateForm('scope', event.target.value)}>
                {['release', 'slo', 'gateway', 'estate', 'detection', 'incident', 'policy', 'other'].map((scope) => <option value={scope} key={scope}>{scope}</option>)}
              </select>
            </label>
            <label>
              <span className="metric-label">Severity</span>
              <select className="filter-select" value={form.severity} onChange={(event) => updateForm('severity', event.target.value)}>
                {['Critical', 'Major', 'Minor', 'Low'].map((severity) => <option value={severity} key={severity}>{severity}</option>)}
              </select>
            </label>
            <label>
              <span className="metric-label">Owner</span>
              <input className="filter-search-input" value={form.owner} onChange={(event) => updateForm('owner', event.target.value)} />
            </label>
            <label>
              <span className="metric-label">Approver</span>
              <input className="filter-search-input" value={form.approver} onChange={(event) => updateForm('approver', event.target.value)} />
            </label>
            <label>
              <span className="metric-label">Source ID</span>
              <input className="filter-search-input" value={form.sourceId} onChange={(event) => updateForm('sourceId', event.target.value)} placeholder="gate, slo, trace, action id" />
            </label>
            <label>
              <span className="metric-label">Expires in days</span>
              <input className="filter-search-input" type="number" min="1" max="365" value={form.expiresInDays} onChange={(event) => updateForm('expiresInDays', event.target.value)} />
            </label>
          </div>
          <label>
            <span className="metric-label">Reason</span>
            <textarea className="automation-textarea" value={form.reason} onChange={(event) => updateForm('reason', event.target.value)} />
          </label>
          <label>
            <span className="metric-label">Compensating controls</span>
            <textarea className="automation-textarea" value={form.compensatingControls} onChange={(event) => updateForm('compensatingControls', event.target.value)} />
          </label>
          <button className="btn-primary" disabled={busy || !form.title.trim() || form.reason.trim().length < 12}>
            Create Exception
          </button>
        </form>

        <div className="card-container risk-list">
          <div className="section-header">
            <div>
              <h3>Exception Register</h3>
              <p>Active exceptions remain visible in Action Center until revoked or expired.</p>
            </div>
          </div>
          {register.exceptions.length === 0 ? (
            <div className="estate-empty-state">
              <span className="badge badge-success">No accepted risk</span>
              <h3>No exceptions have been recorded.</h3>
              <p>That is correct when release gates, SLOs, and detection cases are clean or unresolved risks are not accepted.</p>
            </div>
          ) : (
            <div className="risk-exception-stack">
              {register.exceptions.map((item) => (
                <article className="risk-exception-card" key={item.id}>
                  <div className="risk-exception-topline">
                    <div>
                      <h4>{item.title}</h4>
                      <p>{item.scope} | owner {item.owner} | approver {item.approver}</p>
                    </div>
                    <div className="button-cluster">
                      <span className={`badge ${severityClass[item.severity]}`}>{item.severity}</span>
                      <span className={`badge ${statusClass[item.status]}`}>{item.status}</span>
                    </div>
                  </div>
                  <p>{item.reason}</p>
                  <div className="risk-control-grid">
                    <span>source: {item.sourceId || 'not linked'}</span>
                    <span>expires: {new Date(item.expiresAt).toLocaleDateString()} ({daysUntil(item.expiresAt)} day(s))</span>
                    <span>controls: {item.compensatingControls.length || 0}</span>
                  </div>
                  {item.compensatingControls.length > 0 && (
                    <ul className="risk-control-list">
                      {item.compensatingControls.map((control) => <li key={control}>{control}</li>)}
                    </ul>
                  )}
                  {item.status === 'active' && (
                    <button className="btn-secondary" onClick={() => handleRevoke(item.id)} disabled={busy}>
                      Revoke Exception
                    </button>
                  )}
                </article>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
