import { useEffect, useState } from 'react';
import {
  bootstrapOnboarding,
  createApiKey,
  fetchConnectGuide,
  fetchConnectivity,
  fetchOnboarding,
  fetchOnboardingStatus,
  fetchReadinessScore,
  fetchSyntheticCanaryLatest,
  routeGatewayChatCompletion,
  runOnboardingProofDrill,
  runReadinessCheck,
  sendOnboardingTestTrace,
  runSyntheticCanary,
  verifyConnectIngest,
} from '../lib/api';

const connectivityBadgeClass = {
  ready: 'badge-success',
  degraded: 'badge-warning',
  missing: 'badge-error',
};

const canaryBadgeClass = {
  pass: 'badge-success',
  warn: 'badge-warning',
  fail: 'badge-error',
};

export default function ConnectCenter({ addToast, refreshDashboard }) {
  const [guide, setGuide] = useState(null);
  const [onboarding, setOnboarding] = useState(null);
  const [proofStatus, setProofStatus] = useState(null);
  const [readinessScore, setReadinessScore] = useState(null);
  const [proofResult, setProofResult] = useState(null);
  const [readinessRun, setReadinessRun] = useState(null);
  const [activeSnippet, setActiveSnippet] = useState('javascript');
  const [serviceName, setServiceName] = useState('checkout-agent-service');
  const [environment, setEnvironment] = useState('staging');
  const [apiKey, setApiKey] = useState('');
  const [verification, setVerification] = useState(null);
  const [gatewayResult, setGatewayResult] = useState(null);
  const [connectivity, setConnectivity] = useState(null);
  const [syntheticCanary, setSyntheticCanary] = useState(null);
  const [busy, setBusy] = useState(false);
  const [canaryBusy, setCanaryBusy] = useState(false);
  const [dataSource, setDataSource] = useState('loading');

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchConnectGuide(),
      fetchOnboarding(),
      fetchOnboardingStatus(),
      fetchReadinessScore(),
      fetchConnectivity(),
      fetchSyntheticCanaryLatest(),
    ])
      .then(([guidePayload, onboardingPayload, proofPayload, readinessPayload, connectivityPayload, canaryPayload]) => {
        if (cancelled) return;
        setGuide(guidePayload);
        setOnboarding(onboardingPayload);
        setProofStatus(proofPayload);
        setReadinessScore(readinessPayload);
        setConnectivity(connectivityPayload);
        setSyntheticCanary(canaryPayload);
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
    const [payload, proofPayload, readinessPayload] = await Promise.all([
      fetchOnboarding(),
      fetchOnboardingStatus(),
      fetchReadinessScore(),
    ]);
    setOnboarding(payload);
    setProofStatus(proofPayload);
    setReadinessScore(readinessPayload);
    return payload;
  };

  const refreshConnectivity = async () => {
    const payload = await fetchConnectivity();
    setConnectivity(payload);
    return payload;
  };

  const handleRunCanary = async () => {
    setCanaryBusy(true);
    try {
      const result = await runSyntheticCanary({ target: environment === 'prod' ? 'production' : environment });
      setSyntheticCanary(result);
      await refreshConnectivity();
      refreshDashboard?.();
      addToast(`Synthetic canary completed: ${result.decision.toUpperCase()}.`, result.decision === 'block' ? 'error' : result.decision === 'review' ? 'warning' : 'success');
    } catch (error) {
      addToast(`Synthetic canary failed: ${error.message}`, 'error');
    } finally {
      setCanaryBusy(false);
    }
  };

  const handleBootstrap = async () => {
    setBusy(true);
    try {
      const payload = await bootstrapOnboarding();
      setOnboarding(payload);
      await refreshConnectivity();
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
        scopes: ['trace:ingest', 'gateway:invoke'],
      });
      setApiKey(response.token);
      await Promise.all([refreshOnboarding(), refreshConnectivity()]);
      addToast('Created one-time ingest key. Store it in your server environment.', 'success');
    } catch (error) {
      addToast(`Could not create ingest key: ${error.message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleSendTestTrace = async () => {
    setBusy(true);
    try {
      const result = await sendOnboardingTestTrace();
      await Promise.all([refreshOnboarding(), refreshConnectivity()]);
      refreshDashboard?.();
      addToast(`Onboarding test trace stored: ${result.trace.id}.`, 'success');
    } catch (error) {
      addToast(`Could not store onboarding trace: ${error.message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleProofDrill = async (type) => {
    setBusy(true);
    try {
      const result = await runOnboardingProofDrill(type);
      setProofResult(result);
      await Promise.all([refreshOnboarding(), refreshConnectivity()]);
      refreshDashboard?.();
      addToast(`Proof drill ${result.decision.toUpperCase()}: ${result.evidenceId}.`, result.decision === 'block' ? 'warning' : 'success');
    } catch (error) {
      addToast(`Proof drill failed: ${error.message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleReadinessRun = async () => {
    setBusy(true);
    try {
      const result = await runReadinessCheck();
      setReadinessRun(result);
      await refreshOnboarding();
      addToast(`Readiness evidence created: ${result.evidenceId}.`, result.decision === 'block' ? 'warning' : 'success');
    } catch (error) {
      addToast(`Readiness run failed: ${error.message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleRouteGateway = async () => {
    if (!apiKey.trim()) {
      addToast('Create or paste a gateway-enabled NeuralOps key first.', 'error');
      return;
    }
    setBusy(true);
    try {
      const result = await routeGatewayChatCompletion({
        model: 'neuralops-auto',
        metadata: {
          environment,
          session: `${serviceName}-gateway-smoke`,
        },
        messages: [
          { role: 'system', content: 'You are a concise enterprise support assistant.' },
          { role: 'user', content: 'Summarize an AI incident and list the next owner action.' },
        ],
      }, apiKey.trim());
      setGatewayResult({
        state: 'routed',
        message: `Gateway routed through ${result.neuralops?.provider?.label || 'configured provider'}.`,
        traceId: result.neuralops?.traceId,
        decision: result.neuralops?.decision || 'allow',
      });
      refreshDashboard?.();
      await Promise.all([refreshOnboarding(), refreshConnectivity()]);
      addToast('Gateway call routed and trace evidence stored.', 'success');
    } catch (error) {
      const message = error.message || '';
      const notConfigured = message.includes('not_configured');
      setGatewayResult({
        state: notConfigured ? 'not_configured' : 'blocked',
        message: notConfigured
          ? 'No live provider is configured yet. Add Groq, NVIDIA, OpenRouter, Vercel AI Gateway, Ollama, vLLM, or a custom OpenAI-compatible provider in Settings.'
          : message,
        traceId: extractTraceId(message),
        decision: message.includes('"decision":"block"') ? 'block' : 'review',
      });
      addToast(notConfigured ? 'Gateway is ready but no live provider is configured.' : 'Gateway policy blocked or rejected the call.', notConfigured ? 'warning' : 'error');
      await refreshConnectivity().catch(() => undefined);
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
      await Promise.all([refreshOnboarding(), refreshConnectivity()]);
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

      <div className="connectivity-panel proof-loop-panel">
        <div className="connectivity-summary">
          <div>
            <span className="card-title">5-Minute Production Proof Loop</span>
            <p>
              Create real backend evidence: one persisted trace, one local guardrail block, one readiness report.
              {proofStatus ? ` ${proofStatus.progress}/100 onboarding proof.` : ' Loading proof-loop truth.'}
            </p>
          </div>
          <div className="connectivity-score">
            <strong>{readinessScore?.score ?? 0}</strong>
            <span>{readinessScore?.decision || 'loading'}</span>
          </div>
        </div>
        <div className="connectivity-check-grid">
          {proofStatus?.steps?.map((step) => (
            <div className={`connectivity-check ${step.state === 'complete' ? 'ready' : 'missing'}`} key={step.id}>
              <div className="connectivity-check-header">
                <span className={`badge ${step.state === 'complete' ? 'badge-success' : 'badge-warning'}`}>{step.state}</span>
                <span className="code-font">{step.id}</span>
              </div>
              <strong>{step.label}</strong>
              <p>{step.detail}</p>
            </div>
          ))}
        </div>
        <div className="onboarding-actions">
          <button className="btn-primary" onClick={handleSendTestTrace} disabled={busy}>
            Send Test Trace
          </button>
          <button className="btn-secondary" onClick={() => handleProofDrill('prompt_injection')} disabled={busy}>
            Run Prompt-Injection Drill
          </button>
          <button className="btn-secondary" onClick={handleReadinessRun} disabled={busy}>
            Run Readiness Evidence
          </button>
        </div>
        {proofResult && (
          <div className="connect-proof">
            <span className={`badge ${proofResult.decision === 'block' ? 'badge-warning' : 'badge-success'}`}>
              {proofResult.decision.toUpperCase()}
            </span>
            <strong>{proofResult.summary}</strong>
            {proofResult.trace?.id && <span className="code-font">trace: {proofResult.trace.id}</span>}
            <span className="code-font">evidence: {proofResult.evidenceId}</span>
          </div>
        )}
        {readinessRun && (
          <div className="connect-proof">
            <span className={`badge ${readinessRun.decision === 'block' ? 'badge-warning' : 'badge-success'}`}>
              {readinessRun.decision.toUpperCase()}
            </span>
            <strong>Readiness evidence {readinessRun.evidenceId} created.</strong>
            <span className="code-font">score: {readinessRun.score}/100</span>
            <span className="code-font">evidence: {readinessRun.evidenceId}</span>
          </div>
        )}
      </div>

      <div className="connectivity-panel">
        <div className="connectivity-summary">
          <div>
            <span className="card-title">Connectivity Command Center</span>
            <p>
              {connectivity
                ? `${connectivity.workspaceId} is ${connectivity.overallStatus} with ${connectivity.score}/100 connectivity readiness.`
                : 'Loading real backend connectivity proof.'}
            </p>
          </div>
          <div className="connectivity-score">
            <strong>{connectivity?.score ?? 0}</strong>
            <span>{connectivity?.overallStatus || 'loading'}</span>
          </div>
        </div>
        <div className="connectivity-check-grid">
          {connectivity?.checks.map((check) => (
            <div className={`connectivity-check ${check.status}`} key={check.id}>
              <div className="connectivity-check-header">
                <span className={`badge ${connectivityBadgeClass[check.status] || 'badge-warning'}`}>{check.status}</span>
                <span className="code-font">{check.category}</span>
              </div>
              <strong>{check.label}</strong>
              <p>{check.evidence}</p>
              <span className="code-font">{check.endpoint || check.action}</span>
            </div>
          ))}
        </div>
        {connectivity?.nextActions?.length > 0 && (
          <div className="connectivity-actions">
            {connectivity.nextActions.slice(0, 4).map((action) => (
              <div key={action.id}>
                <span className={`badge ${action.priority === 'high' ? 'badge-error' : 'badge-warning'}`}>{action.priority}</span>
                <strong>{action.label}</strong>
                <p>{action.reason}</p>
              </div>
            ))}
          </div>
        )}
        <div className="synthetic-canary-panel">
          <div>
            <span className="card-title">Synthetic Production Canary</span>
            <p>
              Runs a backend write/read probe, trace roundtrip, OTel normalization, provider gateway readiness, webhook delivery readiness, and automation worker check.
            </p>
          </div>
          <button className="btn-primary" onClick={handleRunCanary} disabled={canaryBusy}>
            {canaryBusy ? 'Running Canary...' : 'Run Synthetic Canary'}
          </button>
          {syntheticCanary && (
            <div className="synthetic-canary-result">
              <div className="synthetic-canary-summary">
                <span className={`badge ${syntheticCanary.decision === 'allow' ? 'badge-success' : syntheticCanary.decision === 'review' ? 'badge-warning' : 'badge-error'}`}>
                  {syntheticCanary.decision}
                </span>
                <strong>{syntheticCanary.score}/100</strong>
                <span className="code-font">{syntheticCanary.id}</span>
              </div>
              <div className="synthetic-canary-checks">
                {syntheticCanary.checks.map((check) => (
                  <div key={check.id}>
                    <span className={`badge ${canaryBadgeClass[check.status] || 'badge-warning'}`}>{check.status}</span>
                    <strong>{check.label}</strong>
                    <p>{check.evidence}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
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

      <div className="connect-layout" style={{ marginTop: '24px' }}>
        <div className="card-container">
          <span className="card-title">2. Route First LLM Call</span>
          <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
            This uses the OpenAI-compatible NeuralOps Gateway. It stores policy, provider, latency, token, cost, trace, and audit evidence.
          </p>
          <button className="btn-primary" onClick={handleRouteGateway} disabled={busy}>
            {busy ? 'Routing...' : 'Route First LLM Call'}
          </button>
          {gatewayResult && (
            <div className={`connect-proof ${gatewayResult.state === 'not_configured' ? 'gateway-not-configured' : ''}`}>
              <span className={`badge ${gatewayResult.decision === 'block' ? 'badge-blocked' : gatewayResult.state === 'not_configured' ? 'badge-warning' : 'badge-success'}`}>
                gateway {gatewayResult.state}
              </span>
              <strong>{gatewayResult.message}</strong>
              {gatewayResult.traceId && <span className="code-font">trace: {gatewayResult.traceId}</span>}
              <span className="code-font">decision: {gatewayResult.decision}</span>
            </div>
          )}
        </div>
        <div className="dark-panel-container">
          <div className="dark-panel-title-row">
            <span className="dark-panel-title">Gateway Contract</span>
            <span className="badge badge-warning">Policy</span>
          </div>
          <div className="dark-list">
            <div className="dark-list-item">
              <div className="item-meta">
                <span className="item-title">Endpoint</span>
                <span className="item-subtitle">{guide?.gatewayEndpoint || `${guide?.apiBaseUrl || 'loading'}/api/gateway/openai/v1/chat/completions`}</span>
              </div>
            </div>
            <div className="dark-list-item">
              <div className="item-meta">
                <span className="item-title">Required scope</span>
                <span className="item-subtitle">gateway:invoke</span>
              </div>
            </div>
            <div className="dark-list-item">
              <div className="item-meta">
                <span className="item-title">Failure truth</span>
                <span className="item-subtitle">Returns not_configured when no live provider exists.</span>
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

function extractTraceId(text) {
  const match = String(text).match(/tr_gateway_[a-f0-9]+/i);
  return match?.[0] || null;
}
