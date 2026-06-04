import { useCallback, useEffect, useMemo, useState } from 'react';
import { analyzeLatestDetection, fetchDetections, patchDetectionAction } from '../lib/api';

const severityClass = {
  Critical: 'badge-error',
  Major: 'badge-warning',
  Minor: 'badge-warning',
  Low: 'badge-success',
};

const decisionClass = {
  block: 'badge-error',
  review: 'badge-warning',
  allow: 'badge-success',
};

export default function DetectionResponse({ addToast, refreshDashboard }) {
  const [cases, setCases] = useState([]);
  const [selectedCaseId, setSelectedCaseId] = useState('');
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [owner, setOwner] = useState('AI Platform Oncall');
  const [note, setNote] = useState('Disable external sink until the trace owner reviews the case.');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const payload = await fetchDetections();
      setCases(payload);
      setSelectedCaseId((current) => current || payload[0]?.id || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Detection API unavailable');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      load();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  const selectedCase = useMemo(() => {
    return cases.find((item) => item.id === selectedCaseId) || cases[0] || null;
  }, [cases, selectedCaseId]);

  const handleAnalyzeLatest = async () => {
    setWorking(true);
    setError('');
    try {
      const detectionCase = await analyzeLatestDetection({ owner });
      await load();
      setSelectedCaseId(detectionCase.id);
      addToast(`Detection case recorded: ${detectionCase.decision.toUpperCase()}.`, detectionCase.decision === 'block' ? 'error' : 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'No risky trace could be analyzed.';
      setError(message);
      addToast('No risky trace is available to analyze yet.', 'warning');
    } finally {
      setWorking(false);
    }
  };

  const handleCaseAction = async (action) => {
    if (!selectedCase) return;
    setWorking(true);
    setError('');
    try {
      const updated = await patchDetectionAction(selectedCase.id, { action, note });
      setCases((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setSelectedCaseId(updated.id);
      refreshDashboard?.();
      const label = action === 'contain' ? 'contained and incident opened' : action === 'close' ? 'closed' : 'reopened';
      addToast(`Detection case ${label}.`, action === 'contain' ? 'warning' : 'success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Detection action failed');
      addToast('Detection action failed in the backend.', 'error');
    } finally {
      setWorking(false);
    }
  };

  const caseCounts = {
    total: cases.length,
    blocked: cases.filter((item) => item.decision === 'block').length,
    open: cases.filter((item) => item.status === 'open').length,
    contained: cases.filter((item) => item.status === 'contained').length,
  };

  return (
    <div className="main-panel">
      <div className="page-header">
        <div>
          <h1 className="page-title">Detection & Response</h1>
          <p className="page-subtitle">
            Investigate risky AI traces, record root cause, estimate blast radius, and persist containment evidence.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            className="filter-search-input"
            style={{ width: '220px' }}
            value={owner}
            onChange={(event) => setOwner(event.target.value)}
            placeholder="case owner"
          />
          <button className="btn-secondary" onClick={load} disabled={loading || working}>
            Refresh Cases
          </button>
          <button className="btn-primary" onClick={handleAnalyzeLatest} disabled={working || !owner.trim()}>
            {working ? 'Analyzing...' : 'Analyze Latest Risky Trace'}
          </button>
        </div>
      </div>

      {error && (
        <div className="state-container" style={{ alignItems: 'flex-start', textAlign: 'left' }}>
          <strong>Detection backend response</strong>
          <span>{error}</span>
        </div>
      )}

      <section className="automation-hero">
        <div>
          <span className="metric-label">Agent Detection & Response</span>
          <h3>Trace risk becomes an investigation record.</h3>
          <p>
            Cases are generated from stored traces, policy signals, risk flags, tool calls, and model outcomes. Containment writes a backend incident and audit event.
          </p>
        </div>
        <div className="automation-stats">
          <div>
            <strong>{caseCounts.total}</strong>
            <span>Cases</span>
          </div>
          <div>
            <strong>{caseCounts.blocked}</strong>
            <span>Blocked</span>
          </div>
          <div>
            <strong>{caseCounts.open}</strong>
            <span>Open</span>
          </div>
          <div>
            <strong>{caseCounts.contained}</strong>
            <span>Contained</span>
          </div>
        </div>
      </section>

      <div className="detection-response-grid">
        <section className="table-container" style={{ padding: '18px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', borderBottom: '1px solid var(--border-color)', paddingBottom: '12px' }}>
            <div>
              <strong>Investigation Queue</strong>
              <p className="page-subtitle">Persisted cases from trace analysis.</p>
            </div>
          </div>
          {loading ? (
            <div className="state-container" style={{ padding: '24px' }}>Loading detection cases...</div>
          ) : cases.length === 0 ? (
            <div className="state-container" style={{ padding: '24px' }}>
              <strong>No detection cases yet</strong>
              <span>Run an agent, ingest traces, then analyze the latest risky trace.</span>
            </div>
          ) : (
            cases.map((item) => (
              <button
                key={item.id}
                className="automation-rule-row"
                style={{
                  width: '100%',
                  textAlign: 'left',
                  background: selectedCase?.id === item.id ? 'var(--bg-active)' : 'var(--bg-card)',
                  cursor: 'pointer',
                }}
                onClick={() => setSelectedCaseId(item.id)}
              >
                <div>
                  <strong>{item.rootCause}</strong>
                  <span className="code-font">{item.id} | source: {item.sourceTraceId || item.sourceType}</span>
                </div>
                <div className="automation-rule-actions">
                  <span className={`badge ${severityClass[item.severity] || 'badge-warning'}`}>{item.severity}</span>
                  <span className={`badge ${decisionClass[item.decision] || 'badge-warning'}`}>{item.status}</span>
                </div>
              </button>
            ))
          )}
        </section>

        <section className="card-container" style={{ minWidth: 0 }}>
          {selectedCase ? (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', borderBottom: '1px solid var(--border-color)', paddingBottom: '14px' }}>
                <div>
                  <span className="metric-label">Case {selectedCase.id}</span>
                  <h3 style={{ marginTop: '6px', fontSize: '20px' }}>{selectedCase.rootCause}</h3>
                </div>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  <span className={`badge ${severityClass[selectedCase.severity] || 'badge-warning'}`}>{selectedCase.severity}</span>
                  <span className={`badge ${decisionClass[selectedCase.decision] || 'badge-warning'}`}>{selectedCase.decision}</span>
                  <span className="badge badge-success">{selectedCase.status}</span>
                </div>
              </div>

              <div className="detection-metric-grid">
                <div className="metric-card">
                  <span className="metric-label">Owner</span>
                  <strong>{selectedCase.owner}</strong>
                </div>
                <div className="metric-card">
                  <span className="metric-label">Trace</span>
                  <strong className="code-font">{selectedCase.sourceTraceId || 'manual'}</strong>
                </div>
                <div className="metric-card">
                  <span className="metric-label">Model</span>
                  <strong className="code-font">{selectedCase.evidence?.trace?.model || 'unknown'}</strong>
                </div>
              </div>

              <div className="detection-evidence-grid">
                <div className="table-container" style={{ padding: '16px' }}>
                  <span className="metric-label">Blast Radius</span>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '12px' }}>
                    {selectedCase.blastRadius.map((item) => <span className="badge badge-warning" key={item}>{item}</span>)}
                  </div>
                </div>
                <div className="table-container" style={{ padding: '16px' }}>
                  <span className="metric-label">Matched Signals</span>
                  <pre style={{ marginTop: '12px', whiteSpace: 'pre-wrap', fontSize: '11px', lineHeight: 1.6 }}>
                    {JSON.stringify(selectedCase.evidence?.matchedSignals || {}, null, 2)}
                  </pre>
                </div>
              </div>

              <div className="table-container" style={{ padding: '16px' }}>
                <span className="metric-label">Recommended Actions</span>
                <div style={{ display: 'grid', gap: '8px', marginTop: '12px' }}>
                  {selectedCase.recommendedActions.map((item) => (
                    <div key={item} style={{ padding: '10px 12px', border: '1px solid var(--border-color)', borderRadius: '10px' }}>
                      {item}
                    </div>
                  ))}
                </div>
              </div>

              <div className="table-container" style={{ padding: '16px' }}>
                <span className="metric-label">Response Note</span>
                <textarea
                  className="automation-textarea"
                  style={{ marginTop: '10px' }}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
                <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '12px' }}>
                  <button className="btn-primary" onClick={() => handleCaseAction('contain')} disabled={working}>
                    Contain + Open Incident
                  </button>
                  <button className="btn-secondary" onClick={() => handleCaseAction('close')} disabled={working}>
                    Close Case
                  </button>
                  <button className="btn-secondary" onClick={() => handleCaseAction('reopen')} disabled={working}>
                    Reopen
                  </button>
                </div>
              </div>

              <div className="table-container" style={{ padding: '16px' }}>
                <span className="metric-label">Case Timeline</span>
                <div style={{ display: 'grid', gap: '10px', marginTop: '12px' }}>
                  {selectedCase.timeline.map((item, index) => (
                    <div key={`${item.title}-${index}`} style={{ display: 'grid', gridTemplateColumns: '150px minmax(0, 1fr)', gap: '12px', borderBottom: '1px solid var(--border-color)', paddingBottom: '10px' }}>
                      <span className="code-font">{item.time}</span>
                      <div>
                        <strong>{item.title}</strong>
                        <p className="page-subtitle" style={{ marginTop: '4px' }}>{item.detail}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div className="state-container">
              <strong>No case selected</strong>
              <span>Create or select a detection case to inspect response evidence.</span>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
