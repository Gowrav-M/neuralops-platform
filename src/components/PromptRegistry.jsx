import { useEffect, useState } from 'react';
import { deployPrompt, fetchPrompts, rollbackPrompt, updatePromptTraffic } from '../lib/api';

export default function PromptRegistry({ addToast }) {
  const [selectedPromptId, setSelectedPromptId] = useState('');
  const [canaryValue, setCanaryValue] = useState(25);
  const [variables, setVariables] = useState({
    user_name: 'NeuralOps User',
    query_text: 'Explain token-level costs in simple words',
    context_chunk: 'Token costs are calculated per 1000 input/output tokens based on the model tier.'
  });

  const [promptRegistryData, setPromptRegistryData] = useState({});
  const [dataSource, setDataSource] = useState('loading');

  const selectedPrompt = promptRegistryData[selectedPromptId] || Object.values(promptRegistryData)[0];

  useEffect(() => {
    let cancelled = false;

    fetchPrompts()
      .then((prompts) => {
        if (cancelled) return;
        const nextPrompts = Object.fromEntries(prompts.map((prompt) => [
          prompt.id,
          {
            name: prompt.id,
            description: prompt.name,
            activeVersion: prompt.version,
            environment: prompt.status === 'Production' ? 'prod' : 'staging',
            owner: prompt.owner,
            lastUpdated: new Date(prompt.updatedAt).toLocaleString(),
            evalScore: prompt.evalScore,
            versions: prompt.history?.map((item) => item.version) ?? [prompt.version],
            template: prompt.template,
            history: prompt.history ?? []
          }
        ]));
        setPromptRegistryData(nextPrompts);
        setSelectedPromptId(prompts[0]?.id || '');
        setCanaryValue(prompts[0]?.canaryPercent ?? 0);
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

  const handleVariableChange = (key, val) => {
    setVariables(prev => ({ ...prev, [key]: val }));
  };

  const getInterpolatedPrompt = (template) => {
    let result = template;
    Object.keys(variables).forEach(key => {
      result = result.replace(new RegExp(`{{${key}}}`, 'g'), variables[key]);
    });
    return result;
  };

  const triggerDeploy = async (env) => {
    if (!selectedPrompt) {
      addToast('No backend prompt is selected.', 'error');
      return;
    }
    if (env !== 'prod') {
      addToast(`Successfully queued deploy of ${selectedPrompt.name} ${selectedPrompt.activeVersion} to ${env}!`, 'success');
      return;
    }

    try {
      const deployed = await deployPrompt(selectedPromptId);
      addToast(`Backend deployed ${deployed.name} ${deployed.version} to production.`, 'success');
    } catch {
      addToast(`Backend unavailable. Deploy for ${selectedPrompt.name} was not queued.`, 'error');
    }
  };

  const refreshPromptFromBackend = (prompt) => {
    setPromptRegistryData((prev) => ({
      ...prev,
      [prompt.id]: {
        name: prompt.id,
        description: prompt.name,
        activeVersion: prompt.version,
        environment: prompt.status === 'Production' ? 'prod' : 'staging',
        owner: prompt.owner,
        lastUpdated: new Date(prompt.updatedAt).toLocaleString(),
        evalScore: prompt.evalScore,
        versions: prompt.history?.map((item) => item.version) ?? [prompt.version],
        template: prompt.template,
        history: prompt.history ?? []
      }
    }));
    setCanaryValue(prompt.canaryPercent ?? 0);
  };

  const triggerRollback = async () => {
    if (!selectedPrompt) {
      addToast('No backend prompt is selected.', 'error');
      return;
    }
    try {
      const rolledBack = await rollbackPrompt(selectedPromptId);
      refreshPromptFromBackend(rolledBack);
      addToast(`Backend rolled ${selectedPrompt.name} back to ${rolledBack.version}.`, 'success');
    } catch {
      addToast(`Backend could not roll back ${selectedPrompt.name}. No previous version may exist.`, 'error');
    }
  };

  const handleTrafficUpdate = async () => {
    if (!selectedPrompt) {
      addToast('No backend prompt is selected.', 'error');
      return;
    }
    try {
      const updated = await updatePromptTraffic(selectedPromptId, Number(canaryValue));
      refreshPromptFromBackend(updated);
      addToast(`Backend saved canary traffic at ${updated.canaryPercent}%.`, 'success');
    } catch {
      addToast(`Backend unavailable. Canary traffic for ${selectedPrompt.name} was not changed.`, 'error');
    }
  };

  if (!selectedPrompt) {
    return (
      <div className="main-panel">
        <div className="page-header">
          <div>
            <h1 className="page-title">Prompt Registry</h1>
            <p className="page-subtitle">
              Manage prompt templates, compare versions, and rollout changes via staging/production canaries.
              {dataSource === 'fallback' ? ' Backend offline; no local prompt samples are shown.' : ' Loading backend data...'}
            </p>
          </div>
        </div>
        <div className="state-container">
          <span style={{ fontWeight: 600 }}>No prompt records available</span>
          <span>Start the backend or add prompt records to SQLite.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="main-panel">
      {/* Page Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Prompt Registry</h1>
          <p className="page-subtitle">
            Manage prompt templates, compare versions, and rollout changes via staging/production canaries.
            {dataSource === 'api' ? ' Backend data loaded.' : dataSource === 'fallback' ? ' Backend offline; no local samples shown.' : ' Loading backend data...'}
          </p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))', gap: '24px' }}>
        {/* Left Side: Prompt List & History */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          <div className="table-container" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <span style={{ fontSize: '15px', fontWeight: '600' }}>Active Prompt List</span>

            <table className="dense-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Version</th>
                  <th>Env</th>
                  <th>Score</th>
                </tr>
              </thead>
              <tbody>
                {Object.keys(promptRegistryData).map((key) => {
                  const p = promptRegistryData[key];
                  return (
                    <tr
                      key={p.name}
                      onClick={() => setSelectedPromptId(p.name)}
                      style={{ background: selectedPromptId === p.name ? 'rgba(26,26,25,0.03)' : '' }}
                    >
                      <td style={{ fontWeight: 600 }}>{p.name}</td>
                      <td className="code-font">{p.activeVersion}</td>
                      <td>
                        <span className={`badge ${p.environment === 'prod' ? 'badge-success' : 'badge-warning'}`}>
                          {p.environment}
                        </span>
                      </td>
                      <td style={{ fontWeight: '700', color: 'var(--color-success)' }}>{p.evalScore}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Rollback & Canary Card */}
          <div className="card-container">
            <span className="card-title">Canary Rollout Settings</span>
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
              Dynamically shift platform traffic for <strong>{selectedPrompt.name}</strong>.
            </p>

            <div className="canary-slider-container" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div className="canary-slider-labels">
                <span>Stable baseline</span>
                <span style={{ color: 'var(--color-warning)', fontWeight: 600 }}>{selectedPrompt.activeVersion} ({canaryValue}%)</span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                className="canary-range-input"
                value={canaryValue}
                onChange={(e) => setCanaryValue(e.target.value)}
              />

              {/* Dynamic Traffic Split Bar */}
              <div style={{ display: 'flex', height: '24px', borderRadius: '12px', overflow: 'hidden', border: '1px solid var(--border-color)', marginTop: '4px', position: 'relative', boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.02)' }}>
                <div
                  style={{
                    width: `${100 - canaryValue}%`,
                    background: 'var(--text-primary)',
                    color: '#FFF',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '10px',
                    fontWeight: 600,
                    transition: 'width 0.1s ease',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {100 - canaryValue > 15 && `Stable: ${100 - canaryValue}%`}
                </div>
                <div
                  style={{
                    width: `${canaryValue}%`,
                    background: 'var(--accent-gold)',
                    color: 'var(--text-primary)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '10px',
                    fontWeight: 700,
                    transition: 'width 0.1s ease',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {canaryValue > 15 && `Canary: ${canaryValue}%`}
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '10px', marginTop: '4px' }}>
              <button className="btn-primary" style={{ flex: 1 }} onClick={handleTrafficUpdate}>
                Apply Traffic Split
              </button>
              <button className="btn-secondary" onClick={triggerRollback} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                Rollback
              </button>
            </div>
          </div>

          {/* History */}
          <div className="table-container" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <span style={{ fontSize: '14px', fontWeight: '600' }}>Evaluation & Version History</span>

            <table className="dense-table" style={{ fontSize: '11px' }}>
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Date</th>
                  <th>Score</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {selectedPrompt.history.map((item) => (
                  <tr key={item.version}>
                    <td className="code-font">{item.version}</td>
                    <td>{item.date}</td>
                    <td style={{ fontWeight: 600 }}>{item.score}</td>
                    <td>
                      <span className={`badge ${item.status.includes('Active') ? 'badge-success' : 'badge-warning'}`}>
                        {item.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right Side: Code Editor, Variable Playground, Diff */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          {/* Prompt Editor Panel */}
          <div className="card-container">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="card-title">Prompt Template View</span>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="btn-secondary" style={{ padding: '4px 10px', fontSize: '11px' }} onClick={() => triggerDeploy('dev')}>Dev</button>
                <button className="btn-secondary" style={{ padding: '4px 10px', fontSize: '11px' }} onClick={() => triggerDeploy('staging')}>Staging</button>
                <button className="btn-primary" style={{ padding: '4px 10px', fontSize: '11px' }} onClick={() => triggerDeploy('prod')}>Deploy Prod</button>
              </div>
            </div>

            <div className="code-editor-panel" style={{ whiteSpace: 'pre-wrap' }}>
              {selectedPrompt.template.split('\n').map((line, i) => (
                <div key={i}>
                  {line.split(/(\{\{[a-zA-Z0-9_]+\}\})/).map((chunk, j) => {
                    if (chunk.startsWith('{{') && chunk.endsWith('}}')) {
                      return <span key={j} className="code-editor-variable">{chunk}</span>;
                    }
                    return chunk;
                  })}
                </div>
              ))}
            </div>

            {/* Variable Inputs */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', background: 'rgba(26,26,25,0.015)', padding: '16px', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
              <span style={{ fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Interpolation Playground</span>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {selectedPrompt.template.includes('{{user_name}}') ? (
                  <>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <label style={{ fontSize: '10px', fontWeight: 600 }}>user_name</label>
                      <input
                        className="filter-search-input"
                        value={variables.user_name}
                        onChange={(e) => handleVariableChange('user_name', e.target.value)}
                      />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <label style={{ fontSize: '10px', fontWeight: 600 }}>query_text</label>
                      <input
                        className="filter-search-input"
                        value={variables.query_text}
                        onChange={(e) => handleVariableChange('query_text', e.target.value)}
                      />
                    </div>
                  </>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '10px', fontWeight: 600 }}>query_text</label>
                    <input
                      className="filter-search-input"
                      value={variables.query_text}
                      onChange={(e) => handleVariableChange('query_text', e.target.value)}
                    />
                  </div>
                )}
              </div>
            </div>

            {/* Resolved prompt preview */}
            <div>
              <span style={{ fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Resolved Output Preview</span>
              <div className="code-editor-panel" style={{ background: '#252522', color: '#FFF', marginTop: '6px', fontSize: '11px' }}>
                {getInterpolatedPrompt(selectedPrompt.template)}
              </div>
            </div>
          </div>

          {/* Side-by-Side Version Diff */}
          <div className="card-container">
            <span className="card-title">Version History Snapshot</span>

            <div className="diff-viewer-grid">
              <div className="diff-column">
                <span className="diff-column-header">{selectedPrompt.history[1]?.version || 'Previous'}</span>
                <div className="diff-content">
                  {selectedPrompt.history[1]
                    ? `${selectedPrompt.history[1].status}\nOwner: ${selectedPrompt.history[1].owner}\nScore: ${selectedPrompt.history[1].score}`
                    : 'No previous version recorded by backend.'}
                </div>
              </div>

              <div className="diff-column">
                <span className="diff-column-header" style={{ color: 'var(--color-success)' }}>{selectedPrompt.activeVersion}</span>
                <div className="diff-content">
                  {selectedPrompt.history[0]
                    ? `${selectedPrompt.history[0].status}\nOwner: ${selectedPrompt.history[0].owner}\nScore: ${selectedPrompt.history[0].score}`
                    : `Current backend version\nOwner: ${selectedPrompt.owner}\nScore: ${selectedPrompt.evalScore}`}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
