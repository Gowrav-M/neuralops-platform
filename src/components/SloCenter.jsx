import { useEffect, useMemo, useState } from 'react';
import { createAiSlo, evaluateAiSlo, evaluateAiSlos, fetchAiSlos, patchAiSlo } from '../lib/api';

const DEFAULT_FORM = {
  name: 'Production AI reliability SLO',
  environment: 'prod',
  serviceFilter: '',
  maxP95LatencyMs: 2500,
  minSuccessRate: 0.98,
  minEvalScore: 0.85,
  maxPolicyViolationRate: 0.02,
  maxCostUsd: 25,
  windowTraceLimit: 200,
  enabled: true,
};

function decisionClass(decision) {
  if (decision === 'block') return 'badge-error';
  if (decision === 'review') return 'badge-warning';
  return 'badge-success';
}

function checkClass(status) {
  if (status === 'fail') return 'badge-error';
  if (status === 'warn') return 'badge-warning';
  return 'badge-success';
}

function formatPercent(value) {
  return `${Math.round(Number(value || 0) * 100)}%`;
}

function evaluationFor(evaluations, sloId) {
  return evaluations.find((item) => item.sloId === sloId) || null;
}

export default function SloCenter({ addToast }) {
  const [dashboard, setDashboard] = useState({ slos: [], evaluations: [], summary: {} });
  const [form, setForm] = useState(DEFAULT_FORM);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const summary = dashboard.summary || {};
  const sortedSlos = useMemo(() => dashboard.slos || [], [dashboard.slos]);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const payload = await fetchAiSlos();
      setDashboard(payload);
    } catch (err) {
      setError(err.message || 'Failed to load AI SLOs.');
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

  const updateForm = (key, value) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const handleCreate = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await createAiSlo({
        ...form,
        serviceFilter: form.serviceFilter.trim() || null,
        maxP95LatencyMs: Number(form.maxP95LatencyMs),
        minSuccessRate: Number(form.minSuccessRate),
        minEvalScore: Number(form.minEvalScore),
        maxPolicyViolationRate: Number(form.maxPolicyViolationRate),
        maxCostUsd: Number(form.maxCostUsd),
        windowTraceLimit: Number(form.windowTraceLimit),
      });
      const payload = await fetchAiSlos();
      setDashboard(payload);
      addToast?.('AI SLO created from production thresholds.');
    } catch (err) {
      setError(err.message || 'Failed to create AI SLO.');
    } finally {
      setBusy(false);
    }
  };

  const handleEvaluateAll = async () => {
    setBusy(true);
    setError('');
    try {
      const payload = await evaluateAiSlos();
      setDashboard(payload);
      addToast?.('AI SLOs evaluated and evidence persisted.');
    } catch (err) {
      setError(err.message || 'SLO evaluation failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleEvaluateOne = async (sloId) => {
    setBusy(true);
    setError('');
    try {
      const evaluation = await evaluateAiSlo(sloId);
      setDashboard((current) => ({
        ...current,
        evaluations: [evaluation, ...(current.evaluations || []).filter((item) => item.sloId !== sloId)],
      }));
      addToast?.(`${evaluation.sloName} evaluated: ${evaluation.decision}.`, evaluation.decision === 'block' ? 'warning' : 'success');
    } catch (err) {
      setError(err.message || 'SLO evaluation failed.');
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = async (slo) => {
    setBusy(true);
    setError('');
    try {
      const updated = await patchAiSlo(slo.id, { enabled: !slo.enabled });
      setDashboard((current) => ({
        ...current,
        slos: current.slos.map((item) => (item.id === updated.id ? updated : item)),
      }));
    } catch (err) {
      setError(err.message || 'Failed to update AI SLO.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="estate-empty-state">
        <div className="spinner" />
        <h1 className="page-title">AI SLO Center</h1>
        <p className="section-subtitle">Loading production contracts from the backend store.</p>
      </div>
    );
  }

  return (
    <div className="slo-page">
      <div className="page-intro slo-hero">
        <div>
          <span className="badge badge-success">Error Budget Control</span>
          <h1 className="page-title">AI SLO Center</h1>
          <p className="section-subtitle">
            Define production contracts for AI workflows, evaluate them against real traces, and persist release evidence before shipping.
          </p>
        </div>
        <div className="button-cluster">
          <button className="btn-secondary" onClick={load} disabled={busy}>Refresh</button>
          <button className="btn-primary" onClick={handleEvaluateAll} disabled={busy || sortedSlos.length === 0}>
            {busy ? 'Evaluating...' : 'Evaluate SLOs'}
          </button>
        </div>
      </div>

      {error && (
        <div className="alert-banner alert-error">
          <strong>SLO control unavailable</strong>
          <span>{error}</span>
        </div>
      )}

      <section className="summary-grid slo-summary-grid" aria-label="AI SLO summary">
        <div className="stat-card highlight">
          <span className="stat-label">SLO Targets</span>
          <span className="stat-value">{summary.targetCount || 0}</span>
          <span className="stat-trend">persisted contracts</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Allow</span>
          <span className="stat-value">{summary.allow || 0}</span>
          <span className="stat-trend positive">safe to promote</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Review</span>
          <span className="stat-value">{summary.review || 0}</span>
          <span className="stat-trend">needs owner review</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Block</span>
          <span className="stat-value">{summary.block || 0}</span>
          <span className="stat-trend negative">release risk</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Error Budget</span>
          <span className="stat-value">{formatPercent(summary.avgErrorBudgetRemaining)}</span>
          <span className="stat-trend">average remaining</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Trace Coverage</span>
          <span className="stat-value">{summary.traceCoverage || 0}</span>
          <span className="stat-trend">evaluated records</span>
        </div>
      </section>

      <section className="slo-layout">
        <form className="card-container slo-create-panel" onSubmit={handleCreate}>
          <div className="section-header">
            <div>
              <h3>Create AI SLO</h3>
              <p>Start with strict production defaults, then tune thresholds when real traffic proves the baseline.</p>
            </div>
          </div>
          <div className="slo-form-grid">
            <label>
              Name
              <input value={form.name} onChange={(event) => updateForm('name', event.target.value)} />
            </label>
            <label>
              Environment
              <select value={form.environment} onChange={(event) => updateForm('environment', event.target.value)}>
                <option value="prod">prod</option>
                <option value="staging">staging</option>
                <option value="dev">dev</option>
                <option value="all">all</option>
              </select>
            </label>
            <label>
              Service filter
              <input value={form.serviceFilter} placeholder="optional session, model, app, prompt" onChange={(event) => updateForm('serviceFilter', event.target.value)} />
            </label>
            <label>
              p95 latency ms
              <input type="number" min="1" value={form.maxP95LatencyMs} onChange={(event) => updateForm('maxP95LatencyMs', event.target.value)} />
            </label>
            <label>
              min success rate
              <input type="number" min="0" max="1" step="0.01" value={form.minSuccessRate} onChange={(event) => updateForm('minSuccessRate', event.target.value)} />
            </label>
            <label>
              min eval score
              <input type="number" min="0" max="1" step="0.01" value={form.minEvalScore} onChange={(event) => updateForm('minEvalScore', event.target.value)} />
            </label>
            <label>
              max policy violation rate
              <input type="number" min="0" max="1" step="0.01" value={form.maxPolicyViolationRate} onChange={(event) => updateForm('maxPolicyViolationRate', event.target.value)} />
            </label>
            <label>
              max cost window
              <input type="number" min="0" step="0.01" value={form.maxCostUsd} onChange={(event) => updateForm('maxCostUsd', event.target.value)} />
            </label>
          </div>
          <button className="btn-primary full-width" disabled={busy || !form.name.trim()}>
            Create SLO Target
          </button>
        </form>

        <div className="card-container slo-list-panel">
          <div className="section-header">
            <div>
              <h3>SLO Evaluations</h3>
              <p>Each result is computed from persisted trace latency, status, score, risk flags, and cost.</p>
            </div>
          </div>

          {sortedSlos.length === 0 ? (
            <div className="estate-empty-state">
              <span className="badge badge-warning">No SLOs configured</span>
              <h3>No release contract exists yet.</h3>
              <p>Create a target to start measuring whether AI workflows are safe, reliable, and cost-bounded.</p>
            </div>
          ) : (
            <div className="slo-card-stack">
              {sortedSlos.map((slo) => {
                const evaluation = evaluationFor(dashboard.evaluations || [], slo.id);
                return (
                  <article className="slo-evaluation-card" key={slo.id}>
                    <div className="slo-card-topline">
                      <div>
                        <h4>{slo.name}</h4>
                        <p>{slo.environment} | {slo.serviceFilter || 'all observed AI traffic'} | last updated {new Date(slo.updatedAt).toLocaleString()}</p>
                      </div>
                      <div className="button-cluster">
                        <span className={`badge ${decisionClass(evaluation?.decision || 'review')}`}>{evaluation?.decision || 'review'}</span>
                        <button className="btn-secondary" onClick={() => toggleEnabled(slo)} disabled={busy}>
                          {slo.enabled ? 'Disable' : 'Enable'}
                        </button>
                        <button className="btn-primary" onClick={() => handleEvaluateOne(slo.id)} disabled={busy || !slo.enabled}>
                          Evaluate
                        </button>
                      </div>
                    </div>
                    <div className="slo-threshold-grid">
                      <span>p95 {'<='} {slo.maxP95LatencyMs}ms</span>
                      <span>success {'>='} {(slo.minSuccessRate * 100).toFixed(0)}%</span>
                      <span>eval {'>='} {slo.minEvalScore.toFixed(2)}</span>
                      <span>policy {'<='} {(slo.maxPolicyViolationRate * 100).toFixed(1)}%</span>
                      <span>cost {'<='} ${slo.maxCostUsd.toFixed(2)}</span>
                    </div>
                    {evaluation ? (
                      <>
                        <div className="slo-budget-row">
                          <div>
                            <strong>{evaluation.score}/100</strong>
                            <span> score</span>
                          </div>
                          <div>
                            <strong>{evaluation.traceCount}</strong>
                            <span> traces</span>
                          </div>
                          <div>
                            <strong>{formatPercent(evaluation.errorBudgetRemaining)}</strong>
                            <span> error budget</span>
                          </div>
                          <div>
                            <strong>{evaluation.burnRate.toFixed(2)}x</strong>
                            <span> burn rate</span>
                          </div>
                        </div>
                        <div className="slo-check-grid">
                          {evaluation.checks.map((check) => (
                            <div className="slo-check" key={check.id}>
                              <div className="slo-check-header">
                                <strong>{check.label}</strong>
                                <span className={`badge ${checkClass(check.status)}`}>{check.status}</span>
                              </div>
                              <p>{check.actual} / {check.target}</p>
                              <small>{check.evidence}</small>
                            </div>
                          ))}
                        </div>
                      </>
                    ) : (
                      <p className="section-subtitle">No evaluation has been run yet.</p>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
