import { useEffect, useState } from 'react';
import { fetchPolicies, fetchPolicyViolations, patchPolicy, testPolicy } from '../lib/api';

export default function PolicyManager({ addToast }) {
  const [policies, setPolicies] = useState([]);
  const [dataSource, setDataSource] = useState('loading');

  const [selectedPolicyId, setSelectedPolicyId] = useState('pol_02');
  const [testInput, setTestInput] = useState('');
  const [testResult, setTestResult] = useState(null);
  const [violations, setViolations] = useState([]);

  const selectedPolicy = policies.find(p => p.id === selectedPolicyId) || policies[0];

  const handleTogglePolicy = async (id) => {
    const policy = policies.find((item) => item.id === id);
    if (!policy) return;
    try {
      const updated = await patchPolicy(id, { enabled: !policy.status });
      setPolicies(prev => prev.map(p => (
        p.id === id ? { ...p, status: updated.enabled, mode: updated.mode === 'review' ? 'warn' : updated.mode } : p
      )));
      addToast(`Backend ${updated.enabled ? 'enabled' : 'disabled'} policy "${policy.name}".`, 'success');
    } catch {
      addToast(`Backend unavailable. Policy "${policy.name}" was not changed.`, 'error');
    }
  };

  const handleModeChange = async (id, newMode) => {
    const policy = policies.find((item) => item.id === id);
    if (!policy) return;
    const backendMode = newMode === 'warn' ? 'review' : newMode;
    try {
      const updated = await patchPolicy(id, { mode: backendMode });
      setPolicies(prev => prev.map(p => (
        p.id === id ? { ...p, mode: updated.mode === 'review' ? 'warn' : updated.mode } : p
      )));
      addToast(`Backend changed "${policy.name}" enforcement to ${newMode}.`, 'success');
    } catch {
      addToast(`Backend unavailable. Enforcement for "${policy.name}" was not changed.`, 'error');
    }
  };

  const [isEvaluating, setIsEvaluating] = useState(false);

  useEffect(() => {
    let cancelled = false;

    Promise.all([fetchPolicies(), fetchPolicyViolations()])
      .then((items) => {
        if (cancelled) return;
        const [policyItems, violationItems] = items;
        setPolicies(policyItems.map((item) => ({
          id: item.id,
          name: item.name,
          type: item.severity,
          status: item.enabled,
          mode: item.mode === 'review' ? 'warn' : item.mode,
          matches: item.matches,
          desc: `${item.matches} matches observed. Enforcement severity: ${item.severity}.`
        })));
        setViolations(violationItems);
        setSelectedPolicyId(policyItems[0]?.id || 'pol_01');
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

  const handleTestPolicy = async () => {
    setIsEvaluating(true);
    setTestResult(null);
    addToast('Evaluating guardrails... Running systemic prompt scanning models.', 'warning');

    try {
      const apiResult = await testPolicy(testInput, selectedPolicyId);
      const result = {
        verdict: apiResult.decision === 'block' ? 'BLOCKED' : apiResult.decision === 'review' ? 'REVIEW REQUIRED' : 'PASSED',
        reason: apiResult.reason,
        status: apiResult.decision === 'block' ? 'error' : apiResult.decision === 'review' ? 'warning' : 'success'
      };
      setTestResult(result);
      if (result.status === 'error') {
        addToast('Guardrail Triggered: Input blocked by prompt injection policy.', 'error');
      } else if (result.status === 'warning') {
        addToast('Guardrail Triggered: Input requires approval review.', 'warning');
      } else {
        addToast('Guardrail Check: Input cleared security scan.', 'success');
      }
    } catch {
      setTestResult(null);
      addToast('Backend unavailable. Policy test was not run.', 'error');
    } finally {
      setIsEvaluating(false);
    }
  };

  if (!selectedPolicy) {
    return (
      <div className="main-panel">
        <div className="page-header">
          <div>
            <h1 className="page-title">Policy Manager</h1>
            <p className="page-subtitle">
              Configure real-time guardrail policies, enforcement actions, and sandbox test scenarios.
              {dataSource === 'api' ? ' Backend connected with no policy records.' : dataSource === 'fallback' ? ' Backend offline; no local policy samples are shown.' : ' Loading backend data...'}
            </p>
          </div>
        </div>
        <div className="state-container">
          <span style={{ fontWeight: 600 }}>No policy records available</span>
          <span>Start the backend or add policy records to SQLite.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="main-panel">
      {/* Page Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Policy Manager</h1>
          <p className="page-subtitle">
            Configure real-time guardrail policies, enforcement actions, and sandbox test scenarios.
            {dataSource === 'api' ? ' Backend connected.' : dataSource === 'fallback' ? ' Backend offline; no local samples shown.' : ' Loading backend data...'}
          </p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))', gap: '24px' }}>
        {/* Left Side: Policies & Logs */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          {/* Policy List card */}
          <div className="table-container" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <span style={{ fontSize: '15px', fontWeight: '600' }}>Platform Guardrail Policies</span>

            <table className="dense-table" style={{ fontSize: '11.5px' }}>
              <thead>
                <tr>
                  <th>Policy Name</th>
                  <th>Type</th>
                  <th>Mode</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {policies.map((p) => (
                  <tr
                    key={p.id}
                    onClick={() => setSelectedPolicyId(p.id)}
                    style={{ background: selectedPolicyId === p.id ? 'rgba(26,26,25,0.03)' : '' }}
                  >
                    <td style={{ fontWeight: 600 }}>{p.name}</td>
                    <td className="code-font">{p.type}</td>
                    <td>
                      <select
                        className="filter-select"
                        style={{ padding: '2px 6px', fontSize: '10px' }}
                        value={p.mode}
                        onChange={(e) => handleModeChange(p.id, e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <option value="monitor">monitor</option>
                        <option value="warn">warn</option>
                        <option value="block">block</option>
                      </select>
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <button
                        className={`btn-primary`}
                          style={{
                            padding: '4px 10px',
                            fontSize: '10px',
                            background: p.status ? 'var(--button-primary-bg)' : 'var(--bg-hover)',
                            color: p.status ? 'var(--button-primary-text)' : 'var(--text-secondary)'
                          }}
                        onClick={() => handleTogglePolicy(p.id)}
                      >
                        {p.status ? 'Enabled' : 'Disabled'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Test Policy Playground Panel */}
          <div className="card-container">
            <span className="card-title">Policy Sandbox Tester</span>
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
              Type user queries to test the active security policy engines in real time.
            </p>

            <div className="sandbox-input-panel" style={{ marginTop: '4px', gap: '8px' }}>
              <textarea
                className="sandbox-textarea"
                placeholder="Paste a real user query or agent instruction to evaluate..."
                value={testInput}
                onChange={(e) => setTestInput(e.target.value)}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>
                  Active policies will scan this prompt payload.
                </span>
                <button className="btn-primary" onClick={handleTestPolicy} disabled={testInput.trim().length === 0}>
                  Evaluate Guardrails
                </button>
              </div>
            </div>

            {/* Test result or scanning display */}
            {isEvaluating && (
              <div className="state-container" style={{ marginTop: '8px', padding: '16px', display: 'flex', flexDirection: 'row', gap: '12px', background: 'rgba(26,26,25,0.01)', border: '1px dashed var(--border-color)', alignItems: 'center' }}>
                <div className="spinner"></div>
                <div style={{ textAlign: 'left' }}>
                  <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-primary)' }}>Scanning prompt security...</span>
                  <p style={{ fontSize: '9.5px', color: 'var(--text-secondary)' }}>Comparing tokens with Jailbreak Injection templates</p>
                </div>
              </div>
            )}

            {testResult && !isEvaluating && (
              <div
                style={{
                  background: testResult.status === 'success' ? 'var(--color-success-light)' : testResult.status === 'warning' ? 'var(--color-warning-light)' : 'var(--color-error-light)',
                  border: `1px solid ${
                    testResult.status === 'success' ? 'rgba(76,158,122,0.2)' : testResult.status === 'warning' ? 'rgba(234,168,56,0.2)' : 'rgba(220,90,69,0.2)'
                  }`,
                  padding: '12px 16px',
                  borderRadius: '8px',
                  marginTop: '8px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                  animation: 'scaleUp 0.3s cubic-bezier(0.16, 1, 0.3, 1)'
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '11px', fontWeight: '700', textTransform: 'uppercase', color: 'var(--text-primary)' }}>
                    Verdict: {testResult.verdict}
                  </span>
                  <span className={`badge ${
                    testResult.status === 'success' ? 'badge-success' : testResult.status === 'warning' ? 'badge-warning' : 'badge-error'
                  }`}>
                    {testResult.status}
                  </span>
                </div>
                <p style={{ fontSize: '11px', lineHeight: '1.4', color: 'var(--text-secondary)' }}>
                  {testResult.reason}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Right Side: Policy Details Editor */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          <div className="card-container">
            <span className="card-title">Policy Definition JSON Schema</span>
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '-8px' }}>
              Detailed config schema for <strong>{selectedPolicy.name}</strong>.
            </p>

            <pre className="code-editor-panel" style={{ height: '320px', overflowY: 'auto' }}>
              {JSON.stringify({
                policy_id: selectedPolicy?.id,
                name: selectedPolicy.name,
                type: selectedPolicy.type,
                description: selectedPolicy.desc,
                enforcement: {
                  mode: selectedPolicy.mode,
                  active: selectedPolicy.status,
                  exception_roles: ['super_admin']
                },
                parameters: selectedPolicy.type === 'prompt injection' ? {
                  matched_count: selectedPolicy.matches ?? 0,
                  patterns: ['ignore previous', 'override instruction', 'jailbreak system']
                } : selectedPolicy.type === 'PII masking' ? {
                  matched_count: selectedPolicy.matches ?? 0,
                  entities: ['EMAIL', 'PHONE_NUMBER', 'SSN', 'IP_ADDRESS']
                } : {
                  matched_count: selectedPolicy.matches ?? 0,
                  severity: selectedPolicy.type
                }
              }, null, 2)}
            </pre>

            <button
              className="btn-primary"
              disabled
              title="Policy schema editing is not implemented in this local API yet."
            >
              Schema Editing Not Connected
            </button>
          </div>

          {/* Violation log card */}
          <div className="table-container" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <span style={{ fontSize: '13px', fontWeight: '600' }}>Recent Policy Violations Log</span>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {violations.length > 0 ? violations.map((violation) => (
                <div key={violation.id} style={{ padding: '10px', background: 'rgba(26,26,25,0.015)', border: '1px solid var(--border-color)', borderRadius: '6px', fontSize: '11px', display: 'flex', flexDirection: 'column', gap: '3px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600, gap: '10px' }}>
                    <span style={{ color: violation.decision === 'blocked' ? 'var(--color-blocked)' : 'var(--color-warning)' }}>
                      {violation.decision.toUpperCase()}: {violation.policyName}
                    </span>
                    <span>{violation.time}</span>
                  </div>
                  <p style={{ color: 'var(--text-secondary)' }}>
                    Trace {violation.subject}: {violation.summary}
                  </p>
                </div>
              )) : (
                <div className="state-container" style={{ padding: '16px', gap: '4px' }}>
                  <span style={{ fontWeight: 600 }}>No policy violations recorded</span>
                  <span>Backend has no violation records for this workspace.</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
