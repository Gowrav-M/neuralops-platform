import { useEffect, useState } from 'react';
import { bootstrapOnboarding, createApiKey, fetchConnectGuide, fetchOnboarding, verifyConnectIngest } from '../lib/api';

export default function ConnectCenter({ addToast, refreshDashboard }) {
  const [guide, setGuide] = useState(null);
  const [onboarding, setOnboarding] = useState(null);
  const [activeSnippet, setActiveSnippet] = useState('javascript');
  const [serviceName, setServiceName] = useState('checkout-agent-service');
  const [environment, setEnvironment] = useState('staging');
  const [apiKey, setApiKey] = useState('');
  const [verification, setVerification] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dataSource, setDataSource] = useState('loading');

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchConnectGuide(), fetchOnboarding()])
      .then(([guidePayload, onboardingPayload]) => {
        if (cancelled) return;
        setGuide(guidePayload);
        setOnboarding(onboardingPayload);
        setActiveSnippet(guidePayload.snippets[0]?.id || 'javascript');
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

  const active = guide?.snippets.find((snippet) => snippet.id === activeSnippet);
  const completedSteps = onboarding?.steps.filter((step) => step.state === 'complete').length || 0;

  const refreshOnboarding = async () => {
    const payload = await fetchOnboarding();
    setOnboarding(payload);
    return payload;
  };

  const handleBootstrap = async () => {
    setBusy(true);
    try {
      const payload = await bootstrapOnboarding();
      setOnboarding(payload);
      addToast('Workspace onboarding state refreshed from the backend.', 'success');
    } catch (error) {
      addToast(`Could not refresh onboarding: ${error.message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleCreateKey = async () => {
    setBusy(true);
    try {
      const response = await createApiKey({
        name: `${serviceName} ingest`,
        role: 'Developer',
        environment,
        scopes: ['trace:ingest'],
      });
      setApiKey(response.token);
      await refreshOnboarding();
      addToast('Created one-time ingest key. Store it in your server environment.', 'success');
    } catch (error) {
      addToast(`Could not create ingest key: ${error.message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleVerify = async () => {
    if (!apiKey.trim()) {
      addToast('Paste or create an ingest key before verifying.', 'error');
      return;
    }
    setBusy(true);
    try {
      const result = await verifyConnectIngest({
        serviceName,
        environment,
        sdk: activeSnippet,
      }, apiKey.trim());
      setVerification(result);
      refreshDashboard?.();
      await refreshOnboarding();
      addToast(result.message, 'success');
    } catch (error) {
      addToast(`Connection verification failed: ${error.message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = async (text, label) => {
    try {
      await navigator.clipboard.writeText(text);
      addToast(`${label} copied.`, 'success');
    } catch {
      addToast('Clipboard unavailable in this browser.', 'warning');
    }
  };

  return (
    <div className="main-panel">
      <div className="page-header">
        <div>
          <h1 className="page-title">Connect Your AI App</h1>
          <p className="page-subtitle">
            Generate an ingest key, verify the connection, and copy SDK or collector setup for a real application.
            {dataSource === 'api' ? ' Backend connected.' : dataSource === 'fallback' ? ' Backend offline; no local samples shown.' : ' Loading backend data...'}
          </p>
        </div>
      </div>

      <div className="onboarding-panel">
        <div className="onboarding-summary">
          <div>
            <span className="card-title">Production Connect Checklist</span>
            <p>
              {onboarding
                ? `${onboarding.workspace.name} is using ${onboarding.workspace.storage}. ${completedSteps}/${onboarding.steps.length} steps complete.`
                : 'Loading workspace connection state from the backend.'}
            </p>
          </div>
          <div className="onboarding-score" aria-label="Onboarding progress">
            <strong>{onboarding?.progress ?? 0}%</strong>
            <span>{onboarding?.nextAction || 'Waiting for backend status.'}</span>
          </div>
        </div>
        <div className="onboarding-progress-track">
          <span style={{ width: `${onboarding?.progress ?? 0}%` }} />
        </div>
        <div className="onboarding-step-grid">
          {onboarding?.steps.map((step) => (
            <div className={`onboarding-step ${step.state}`} key={step.id}>
              <span className={`badge ${step.state === 'complete' ? 'badge-success' : 'badge-warning'}`}>
                {step.state === 'complete' ? 'complete' : 'next'}
              </span>
              <strong>{step.label}</strong>
              <p>{step.detail}</p>
            </div>
          ))}
        </div>
        <div className="onboarding-actions">
          <button className="btn-secondary" onClick={handleBootstrap} disabled={busy}>
            Refresh Workspace Proof
          </button>
          <span className="code-font">workspace: {onboarding?.workspace.id || 'loading'}</span>
        </div>
      </div>

      <div className="connect-layout">
        <div className="card-container">
          <span className="card-title">1. Create Connection Key</span>
          <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
            NeuralOps stores only a hash. The raw token is shown once and should live in your server environment.
          </p>
          <div className="connect-form-grid">
            <input
              className="filter-search-input"
              value={serviceName}
              onChange={(event) => setServiceName(event.target.value)}
              placeholder="service name"
            />
            <select className="filter-select" value={environment} onChange={(event) => setEnvironment(event.target.value)}>
              <option value="staging">staging</option>
              <option value="prod">prod</option>
              <option value="dev">dev</option>
            </select>
            <button className="btn-primary" onClick={handleCreateKey} disabled={busy || !serviceName.trim()}>
              Create Ingest Key
            </button>
          </div>
          <textarea
            className="sandbox-textarea"
            style={{ minHeight: '86px', fontFamily: 'var(--font-mono)' }}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="Paste NEURALOPS_API_KEY here or create one above."
          />
          <button className="btn-primary" onClick={handleVerify} disabled={busy}>
            {busy ? 'Verifying...' : 'Verify Connection + Store Trace'}
          </button>

          {verification && (
            <div className="connect-proof">
              <span className="badge badge-success">verified</span>
              <strong>{verification.message}</strong>
              <span className="code-font">trace: {verification.trace.id}</span>
              <span className="code-font">audit: {verification.auditId}</span>
            </div>
          )}
        </div>

        <div className="dark-panel-container">
          <div className="dark-panel-title-row">
            <span className="dark-panel-title">Connection Contract</span>
            <span className="badge badge-success">API</span>
          </div>
          <div className="dark-list">
            <div className="dark-list-item">
              <div className="item-meta">
                <span className="item-title">Ingest endpoint</span>
                <span className="item-subtitle">{guide?.ingestEndpoint || 'loading'}</span>
              </div>
            </div>
            <div className="dark-list-item">
              <div className="item-meta">
                <span className="item-title">Auth header</span>
                <span className="item-subtitle">{guide?.authHeader || 'x-neuralops-key'}</span>
              </div>
            </div>
            <div className="dark-list-item">
              <div className="item-meta">
                <span className="item-title">OpenTelemetry endpoint</span>
                <span className="item-subtitle">{guide?.otelEndpoint || 'loading'}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="table-container" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div className="connect-tabs">
          {guide?.snippets.map((snippet) => (
            <button
              className={`tab-btn ${activeSnippet === snippet.id ? 'active' : ''}`}
              key={snippet.id}
              onClick={() => setActiveSnippet(snippet.id)}
            >
              {snippet.label}
            </button>
          ))}
        </div>

        {active ? (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
              <div>
                <span style={{ fontSize: '15px', fontWeight: 700 }}>{active.label}</span>
                {active.command && <p className="code-font" style={{ marginTop: '6px' }}>{active.command}</p>}
              </div>
              <button className="btn-secondary" onClick={() => handleCopy(active.code, active.label)}>
                Copy Snippet
              </button>
            </div>
            <pre className="code-editor-panel" style={{ whiteSpace: 'pre-wrap', maxHeight: '420px', overflowY: 'auto' }}>{active.code}</pre>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              {active.notes.map((note) => (
                <span className="badge badge-warning" key={note}>{note}</span>
              ))}
            </div>
          </>
        ) : (
          <div className="state-container">
            <span>Connect guide is loading from the backend.</span>
          </div>
        )}
      </div>
    </div>
  );
}
