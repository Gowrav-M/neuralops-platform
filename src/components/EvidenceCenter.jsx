import { useEffect, useState } from 'react';
import {
  createReleaseGate,
  fetchEvidenceReport,
  fetchReleaseGates,
  fetchSystemStatus,
  runReleaseGate,
  runSavedReleaseGate,
} from '../lib/api';

const stateLabel = {
  persisted: 'Persisted',
  live_provider: 'Live provider',
  local_drill: 'Local drill',
  not_configured: 'Not configured',
};

const badgeClass = {
  persisted: 'badge-success',
  live_provider: 'badge-success',
  local_drill: 'badge-warning',
  not_configured: 'badge-error',
};

export default function EvidenceCenter({ addToast }) {
  const [status, setStatus] = useState(null);
  const [report, setReport] = useState(null);
  const [releaseGates, setReleaseGates] = useState([]);
  const [runMessage, setRunMessage] = useState('');
  const [gateForm, setGateForm] = useState({
    name: 'Production AI Release Gate',
    target: 'production',
    maxLatencyMs: 2500,
    maxErrorRate: 0.05,
    minEvalPassRate: 0.85,
    requireLiveProvider: false,
    requireAuth: true,
    requireSyntheticCanary: true,
    syntheticCanaryMaxAgeMinutes: 60,
  });
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    setError('');
    try {
      const [nextStatus, nextReport, nextGates] = await Promise.all([
        fetchSystemStatus(),
        fetchEvidenceReport(),
        fetchReleaseGates(),
      ]);
      setStatus(nextStatus);
      setReport(nextReport);
      setReleaseGates(nextGates);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Evidence API unavailable');
    }
  };

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      load();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  const handleRunGate = async () => {
    setRunning(true);
    setRunMessage('');
    setError('');
    try {
      const gate = await runReleaseGate({
        target: gateForm.target,
        maxLatencyMs: Number(gateForm.maxLatencyMs),
        maxErrorRate: Number(gateForm.maxErrorRate),
        minEvalPassRate: Number(gateForm.minEvalPassRate),
        requireLiveProvider: Boolean(gateForm.requireLiveProvider),
        requireAuth: Boolean(gateForm.requireAuth),
        requireSyntheticCanary: Boolean(gateForm.requireSyntheticCanary),
        syntheticCanaryMaxAgeMinutes: Number(gateForm.syntheticCanaryMaxAgeMinutes),
      });
      setReport((currentReport) => ({
        ...(currentReport || {}),
        latestGate: gate,
        summary: {
          ...(currentReport?.summary || {}),
          decision: gate.decision,
        },
      }));
      setRunMessage(`Release gate completed: ${gate.decision.toUpperCase()} (${gate.score}/100).`);
      load();
      addToast(`Release gate completed: ${gate.decision.toUpperCase()} (${gate.score}/100).`, gate.decision === 'block' ? 'error' : 'success');
    } catch (err) {
      addToast('Release gate failed to run against the backend.', 'error');
      setError(err instanceof Error ? err.message : 'Release gate failed');
    } finally {
      setRunning(false);
    }
  };

  const handleCreateGate = async () => {
    setRunning(true);
    try {
      const gate = await createReleaseGate({
        ...gateForm,
        maxLatencyMs: Number(gateForm.maxLatencyMs),
        maxErrorRate: Number(gateForm.maxErrorRate),
        minEvalPassRate: Number(gateForm.minEvalPassRate),
        syntheticCanaryMaxAgeMinutes: Number(gateForm.syntheticCanaryMaxAgeMinutes),
      });
      await load();
      addToast(`Saved release gate: ${gate.name}.`, 'success');
    } catch (err) {
      addToast('Could not save release gate definition.', 'error');
      setError(err instanceof Error ? err.message : 'Could not save release gate');
    } finally {
      setRunning(false);
    }
  };

  const handleRunSavedGate = async (gate) => {
    setRunning(true);
    try {
      const result = await runSavedReleaseGate(gate.id, { gateId: gate.id, failOn: 'block' });
      await load();
      addToast(`Saved gate ${gate.name}: ${result.decision.toUpperCase()} (${result.score}/100).`, result.decision === 'block' ? 'error' : 'success');
    } catch (err) {
      addToast(`Could not run saved gate ${gate.name}.`, 'error');
      setError(err instanceof Error ? err.message : 'Could not run saved gate');
    } finally {
      setRunning(false);
    }
  };

  const updateGateField = (field, value) => {
    setGateForm((current) => ({ ...current, [field]: value }));
  };

  const latestGate = report?.latestGate;

  return (
    <div className="main-panel">
      <div className="page-header">
        <div>
          <h1 className="page-title">Evidence & Release Gate</h1>
          <p className="page-subtitle">
            Prove which NeuralOps features are persisted, live, local-only, or not configured before production deploy.
          </p>
        </div>
        <button className="btn-primary" onClick={handleRunGate} disabled={running}>
          {running ? 'Running Gate...' : 'Run Current Config'}
        </button>
      </div>

      {runMessage && (
        <div className="state-container" style={{ alignItems: 'flex-start', textAlign: 'left' }}>
          <strong>{runMessage}</strong>
          <span>Evidence has been persisted. The larger report is refreshing in the background.</span>
        </div>
      )}

      {error && (
        <div className="state-container" style={{ alignItems: 'flex-start', textAlign: 'left' }}>
          <strong>Evidence backend unavailable</strong>
          <span>{error}</span>
        </div>
      )}

      {status && (
        <>
          <div className="gate-config-panel">
            <div className="dark-panel-title-row">
              <div>
                <span className="dark-panel-title">Saved Release Gates</span>
                <p className="page-subtitle" style={{ marginTop: '6px' }}>
                  Persist thresholds once, run them from the UI, API, CLI, or GitHub Actions.
                </p>
              </div>
              <button className="btn-secondary" onClick={handleCreateGate} disabled={running}>
                Save Gate Definition
              </button>
            </div>

            <div className="gate-config-grid">
              <label>
                <span className="metric-label">Name</span>
                <input className="filter-search-input" value={gateForm.name} onChange={(event) => updateGateField('name', event.target.value)} />
              </label>
              <label>
                <span className="metric-label">Target</span>
                <select className="filter-select" value={gateForm.target} onChange={(event) => updateGateField('target', event.target.value)}>
                  <option value="production">production</option>
                  <option value="staging">staging</option>
                  <option value="ci">ci</option>
                </select>
              </label>
              <label>
                <span className="metric-label">Max Latency</span>
                <input className="filter-search-input" type="number" min="1" value={gateForm.maxLatencyMs} onChange={(event) => updateGateField('maxLatencyMs', event.target.value)} />
              </label>
              <label>
                <span className="metric-label">Max Error Rate</span>
                <input className="filter-search-input" type="number" min="0" max="1" step="0.01" value={gateForm.maxErrorRate} onChange={(event) => updateGateField('maxErrorRate', event.target.value)} />
              </label>
              <label>
                <span className="metric-label">Min Eval Pass</span>
                <input className="filter-search-input" type="number" min="0" max="1" step="0.01" value={gateForm.minEvalPassRate} onChange={(event) => updateGateField('minEvalPassRate', event.target.value)} />
              </label>
              <label>
                <span className="metric-label">Canary Max Age</span>
                <input className="filter-search-input" type="number" min="1" max="1440" value={gateForm.syntheticCanaryMaxAgeMinutes} onChange={(event) => updateGateField('syntheticCanaryMaxAgeMinutes', event.target.value)} />
              </label>
              <label className="gate-checkbox">
                <input type="checkbox" checked={gateForm.requireAuth} onChange={(event) => updateGateField('requireAuth', event.target.checked)} />
                <span>Require auth</span>
              </label>
              <label className="gate-checkbox">
                <input type="checkbox" checked={gateForm.requireLiveProvider} onChange={(event) => updateGateField('requireLiveProvider', event.target.checked)} />
                <span>Require live provider</span>
              </label>
              <label className="gate-checkbox">
                <input type="checkbox" checked={gateForm.requireSyntheticCanary} onChange={(event) => updateGateField('requireSyntheticCanary', event.target.checked)} />
                <span>Require fresh canary</span>
              </label>
            </div>

            <div className="gate-definition-list">
              {releaseGates.length ? releaseGates.map((gate) => (
                <div className="gate-definition-row" key={gate.id}>
                  <div>
                    <strong>{gate.name}</strong>
                    <span className="code-font">
                      {gate.id} | {gate.target} | latency {gate.maxLatencyMs}ms | eval {(gate.minEvalPassRate * 100).toFixed(0)}% | canary {gate.requireSyntheticCanary ? `${gate.syntheticCanaryMaxAgeMinutes}m` : 'optional'}
                    </span>
                  </div>
                  <div className="gate-row-actions">
                    <span className={`badge ${gate.lastDecision === 'block' ? 'badge-error' : gate.lastDecision === 'allow' ? 'badge-success' : 'badge-warning'}`}>
                      {gate.lastDecision || 'not run'}
                    </span>
                    <button className="btn-secondary" onClick={() => handleRunSavedGate(gate)} disabled={running}>
                      Run Saved Gate
                    </button>
                  </div>
                </div>
              )) : (
                <div className="state-container" style={{ padding: '18px' }}>
                  <span>No saved release gates yet. Save the current thresholds to create a CI-ready gate ID.</span>
                </div>
              )}
            </div>
          </div>

          <div className="evidence-hero">
            <div>
              <span className="metric-label">Deployment Readiness</span>
              <div className="evidence-score">{status.readinessScore}/100</div>
              <p className="page-subtitle">
                Storage: <strong>{status.storage}</strong> | Workspace: <strong>{status.workspaceId}</strong> | Auth: <strong>{status.authRequired ? 'required' : 'not enforced'}</strong>
              </p>
            </div>
            <div className="evidence-gate-card">
              <span className="metric-label">Latest Gate</span>
              <span className={`badge ${latestGate?.decision === 'block' ? 'badge-error' : latestGate?.decision === 'allow' ? 'badge-success' : 'badge-warning'}`}>
                {latestGate ? latestGate.decision : 'not run'}
              </span>
              <strong>{latestGate ? `${latestGate.score}/100` : 'Run gate to create evidence'}</strong>
              <span className="page-subtitle">{latestGate?.target || 'production target'}</span>
            </div>
          </div>

          <div className="evidence-grid">
            {status.features.map((feature) => (
              <div className="evidence-card" key={feature.id}>
                <div className="dark-panel-title-row">
                  <strong>{feature.label}</strong>
                  <span className={`badge ${badgeClass[feature.state]}`}>{stateLabel[feature.state]}</span>
                </div>
                <p>{feature.evidence}</p>
                <span>{feature.action}</span>
              </div>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 0.9fr', gap: '24px' }}>
            <div className="table-container" style={{ padding: '24px' }}>
              <span style={{ fontSize: '15px', fontWeight: '600' }}>Release Gate Checks</span>
              <table className="dense-table" style={{ marginTop: '14px' }}>
                <thead>
                  <tr>
                    <th>Check</th>
                    <th>Status</th>
                    <th>Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {latestGate ? latestGate.checks.map((check) => (
                    <tr key={check.id}>
                      <td>{check.label}</td>
                      <td>
                        <span className={`badge ${check.status === 'pass' ? 'badge-success' : check.status === 'warn' ? 'badge-warning' : 'badge-error'}`}>
                          {check.status}
                        </span>
                      </td>
                      <td>{check.evidence}</td>
                    </tr>
                  )) : (
                    <tr>
                      <td colSpan="3" style={{ color: 'var(--text-secondary)' }}>No gate run yet.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="dark-panel-container">
              <div className="dark-panel-title-row">
                <span className="dark-panel-title">Deployment Blockers</span>
                <span className="badge badge-warning">{status.blockers.length}</span>
              </div>
              <div className="dark-list">
                {status.blockers.length ? status.blockers.map((blocker) => (
                  <div className="dark-list-item" key={blocker}>
                    <div className="item-meta">
                      <span className="item-title">{blocker.split(':')[0]}</span>
                      <span className="item-subtitle">{blocker.split(':').slice(1).join(':').trim()}</span>
                    </div>
                  </div>
                )) : (
                  <div className="dark-list-item">
                    <div className="item-meta">
                      <span className="item-title">No blockers found</span>
                      <span className="item-subtitle">All feature states are configured or intentionally local.</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="code-editor-panel" style={{ whiteSpace: 'pre-wrap' }}>
            {report?.markdown || 'Evidence report will appear after backend status loads.'}
          </div>
        </>
      )}
    </div>
  );
}
