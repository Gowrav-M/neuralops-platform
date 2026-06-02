import { useEffect, useMemo, useState } from 'react';
import { fetchAgentDefinitions, fetchAgentProviders, fetchLabExperiments, runLabExperiment } from '../lib/api';

const decisionBadge = {
  allow: 'badge-success',
  review: 'badge-warning',
  block: 'badge-error',
};

export default function NeuralLabs({ addToast, refreshDashboard }) {
  const [agentDefinitions, setAgentDefinitions] = useState([]);
  const [providers, setProviders] = useState([]);
  const [experiments, setExperiments] = useState([]);
  const [selectedAgentIds, setSelectedAgentIds] = useState([]);
  const [experimentName, setExperimentName] = useState('');
  const [providerMode, setProviderMode] = useState('auto');
  const [environment, setEnvironment] = useState('staging');
  const [labInput, setLabInput] = useState('');
  const [activeExperiment, setActiveExperiment] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dataSource, setDataSource] = useState('loading');

  useEffect(() => {
    let cancelled = false;

    Promise.all([fetchAgentDefinitions(), fetchAgentProviders(), fetchLabExperiments()])
      .then(([definitions, providerItems, labItems]) => {
        if (cancelled) return;
        setAgentDefinitions(definitions);
        setProviders(providerItems);
        setExperiments(labItems);
        setSelectedAgentIds(definitions.slice(0, 2).map((agent) => agent.id));
        setActiveExperiment(labItems[0] || null);
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

  const providerSummary = useMemo(() => {
    const configured = providers.filter((provider) => provider.configured);
    return `${configured.length}/${providers.length || 0} providers ready`;
  }, [providers]);

  const toggleAgent = (agentId) => {
    setSelectedAgentIds((current) => {
      if (current.includes(agentId)) {
        return current.length === 1 ? current : current.filter((id) => id !== agentId);
      }
      return [...current, agentId];
    });
  };

  const handleRun = async () => {
    if (labInput.trim().length === 0) {
      addToast('Enter a real task before running a lab experiment.', 'error');
      return;
    }
    setBusy(true);
    try {
      const response = await runLabExperiment({
        name: experimentName.trim() || 'Untitled experiment',
        input: labInput,
        agentIds: selectedAgentIds,
        providerMode,
        environment,
      });
      setExperiments((prev) => [response.experiment, ...prev.filter((item) => item.id !== response.experiment.id)]);
      setActiveExperiment(response.experiment);
      refreshDashboard?.();
      addToast(`Lab experiment saved with ${response.experiment.variants.length} variant(s).`, response.experiment.decision === 'block' ? 'error' : 'success');
    } catch (error) {
      addToast(`Lab experiment failed: ${error.message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="main-panel">
      <div className="page-header">
        <div>
          <h1 className="page-title">Neural Labs</h1>
          <p className="page-subtitle">
            Run real prompt, model, and agent experiments before production. Results become trace, eval, cost, and policy evidence.
            {dataSource === 'api' ? ' Backend connected.' : dataSource === 'fallback' ? ' Backend offline; no local samples shown.' : ' Loading backend data...'}
          </p>
        </div>
      </div>

      <div className="agent-runtime-grid">
        <div className="table-container" style={{ padding: '22px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div>
              <span style={{ fontSize: '16px', fontWeight: 700 }}>Experiment Setup</span>
              <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '6px', maxWidth: '680px' }}>
                Test one real task across multiple agents. Auto mode uses configured live providers when available and falls back to the deterministic local runtime.
              </p>
            </div>
            <span className="badge badge-success" style={{ fontSize: '9px' }}>{providerSummary}</span>
          </div>

          <div className="agent-form-grid">
            <input
              className="filter-search-input"
              value={experimentName}
              onChange={(event) => setExperimentName(event.target.value)}
              placeholder="Experiment name"
            />
            <select className="filter-select" value={providerMode} onChange={(event) => setProviderMode(event.target.value)}>
              <option value="auto">Auto provider</option>
              <option value="local">Local deterministic</option>
              <option value="live">Require live provider</option>
            </select>
            <select className="filter-select" value={environment} onChange={(event) => setEnvironment(event.target.value)}>
              <option value="staging">staging</option>
              <option value="dev">dev</option>
              <option value="prod">prod</option>
            </select>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: '10px' }}>
            {agentDefinitions.map((agent) => (
              <button
                key={agent.id}
                className={`metric-card-square ${selectedAgentIds.includes(agent.id) ? 'active' : ''}`}
                style={{ textAlign: 'left', cursor: 'pointer', padding: '14px', minHeight: '118px' }}
                onClick={() => toggleAgent(agent.id)}
              >
                <span className="metric-label">{agent.name}</span>
                <span style={{ fontSize: '11px', color: 'var(--text-secondary)', lineHeight: 1.35 }}>{agent.role}</span>
                <span className={`badge ${selectedAgentIds.includes(agent.id) ? 'badge-success' : 'badge-warning'}`} style={{ width: 'fit-content', fontSize: '8px' }}>
                  {selectedAgentIds.includes(agent.id) ? 'selected' : 'available'}
                </span>
              </button>
            ))}
          </div>

          <textarea
            className="code-editor-panel"
            style={{ minHeight: '140px', resize: 'vertical', color: 'var(--text-primary)', background: 'var(--bg-card)' }}
            value={labInput}
            onChange={(event) => setLabInput(event.target.value)}
            placeholder="Paste a real prompt, ticket, RAG question, code snippet, or production incident scenario to test."
          />

          <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn-primary" onClick={handleRun} disabled={busy || selectedAgentIds.length === 0 || labInput.trim().length === 0}>
              {busy ? 'Running Lab...' : 'Run Lab Experiment'}
            </button>
            <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
              Stores an experiment packet plus agent runs and trace records.
            </span>
          </div>
        </div>

        <div className="dark-panel-container" style={{ minHeight: 0 }}>
          <div className="dark-panel-title-row">
            <span className="dark-panel-title">Latest Experiment Decision</span>
            <span className={`badge ${activeExperiment ? decisionBadge[activeExperiment.decision] : 'badge-warning'}`} style={{ fontSize: '9px' }}>
              {activeExperiment ? activeExperiment.decision.toUpperCase() : 'NO RUNS'}
            </span>
          </div>

          {activeExperiment ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '12px' }}>
                <Metric label="Variants" value={activeExperiment.summary.variantCount} />
                <Metric label="Best Score" value={`${Math.round(activeExperiment.summary.bestScore * 100)}%`} />
                <Metric label="Winner" value={activeExperiment.summary.winnerAgent} />
                <Metric label="Total Cost" value={`$${activeExperiment.summary.totalCostUsd.toFixed(5)}`} />
              </div>
              <pre style={{ background: 'rgba(0,0,0,0.22)', color: '#fff', borderRadius: '10px', padding: '12px', fontSize: '11px', lineHeight: 1.5, whiteSpace: 'pre-wrap', maxHeight: '220px', overflowY: 'auto' }}>
                {activeExperiment.input}
              </pre>
            </div>
          ) : (
            <div className="state-container" style={{ background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.55)', padding: '36px 0' }}>
              <span style={{ fontSize: '12px' }}>Run a lab experiment to compare outputs, policies, costs, and trace IDs.</span>
            </div>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: '24px' }}>
        <div className="table-container" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <span style={{ fontSize: '15px', fontWeight: 700 }}>Variant Scoreboard</span>
          <table className="dense-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Provider</th>
                <th>Decision</th>
                <th>Score</th>
                <th>Latency</th>
                <th>Cost</th>
                <th>Trace</th>
              </tr>
            </thead>
            <tbody>
              {activeExperiment?.variants?.length > 0 ? activeExperiment.variants.map((variant) => (
                <tr key={variant.runId}>
                  <td style={{ fontWeight: 600 }}>{variant.agentName}</td>
                  <td className="code-font">{variant.provider} / {variant.model}</td>
                  <td><span className={`badge ${decisionBadge[variant.decision]}`}>{variant.decision}</span></td>
                  <td>{Math.round(variant.score * 100)}%</td>
                  <td>{variant.latencyMs}ms</td>
                  <td>${variant.costUsd.toFixed(5)}</td>
                  <td className="code-font">{variant.traceId}</td>
                </tr>
              )) : (
                <tr>
                  <td colSpan="7" style={{ color: 'var(--text-secondary)' }}>No experiment variants have been run yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="table-container" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <span style={{ fontSize: '15px', fontWeight: 700 }}>Experiment History</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {experiments.length > 0 ? experiments.map((experiment) => (
              <button
                key={experiment.id}
                className="cmd-item"
                style={{ border: '1px solid var(--border-color)', borderRadius: '10px', textAlign: 'left', background: activeExperiment?.id === experiment.id ? 'var(--bg-active)' : 'var(--bg-card)' }}
                onClick={() => setActiveExperiment(experiment)}
              >
                <span style={{ display: 'grid', gap: '3px' }}>
                  <strong>{experiment.name}</strong>
                  <span style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>{experiment.createdAt}</span>
                </span>
                <span className={`badge ${decisionBadge[experiment.decision]}`}>{experiment.decision}</span>
              </button>
            )) : (
              <div className="state-container" style={{ padding: '18px' }}>
                <span style={{ fontWeight: 600 }}>No lab experiments yet</span>
                <span>Run a task above to create the first experiment record.</span>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="table-container" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <span style={{ fontSize: '15px', fontWeight: 700 }}>Output Comparison</span>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))', gap: '14px' }}>
          {activeExperiment?.variants?.length > 0 ? activeExperiment.variants.map((variant) => (
            <div key={`${variant.runId}-output`} className="card-container" style={{ gap: '10px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center' }}>
                <span className="card-title">{variant.agentName}</span>
                <span className={`badge ${decisionBadge[variant.decision]}`}>{variant.decision}</span>
              </div>
              <pre style={{ fontSize: '11px', whiteSpace: 'pre-wrap', color: 'var(--text-secondary)', lineHeight: 1.5, maxHeight: '240px', overflowY: 'auto' }}>{variant.output}</pre>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {variant.policyFindings.length > 0 ? variant.policyFindings.map((finding) => (
                  <span key={finding} className="badge badge-error" style={{ fontSize: '8px' }}>{finding}</span>
                )) : (
                  <span className="badge badge-success" style={{ fontSize: '8px' }}>no policy findings</span>
                )}
              </div>
            </div>
          )) : (
            <div className="state-container">
              <span style={{ fontWeight: 600 }}>No output comparison available</span>
              <span>Experiment outputs will appear here after a run.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div>
      <span style={{ color: 'rgba(255,255,255,0.45)', fontSize: '9px', textTransform: 'uppercase' }}>{label}</span>
      <div style={{ color: '#fff', fontWeight: 700, fontSize: '12px', overflowWrap: 'anywhere' }}>{value}</div>
    </div>
  );
}
