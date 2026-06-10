import { useEffect, useMemo, useState } from 'react';
import {
  fetchEstateGraph,
  fetchEstateSummary,
  fetchEstateSystem,
  patchEstateSystem,
  rebuildEstateGraph,
} from '../lib/api';

const KIND_LABELS = {
  app: 'AI Apps',
  agent: 'Agents',
  prompt: 'Prompts',
  model: 'Models',
  provider: 'Providers',
  dataset: 'Datasets',
  policy: 'Policies',
  gateway: 'Gateway',
  evidence: 'Evidence',
};

const KIND_ORDER = ['app', 'agent', 'gateway', 'provider', 'model', 'prompt', 'dataset', 'policy', 'evidence'];

function formatCurrency(value) {
  return `$${Number(value || 0).toFixed(3)}`;
}

function formatLatency(value) {
  if (!value) return '0ms';
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`;
}

function riskClass(risk) {
  if (risk === 'Critical') return 'badge-error';
  if (risk === 'Major') return 'badge-warning';
  if (risk === 'Minor') return 'badge-warning';
  return 'badge-success';
}

function healthClass(status) {
  if (status === 'blocked') return 'badge-error';
  if (status === 'review') return 'badge-warning';
  return 'badge-success';
}

function groupSystems(systems) {
  return systems.reduce((groups, system) => {
    const key = system.kind || 'app';
    return { ...groups, [key]: [...(groups[key] || []), system] };
  }, {});
}

export default function EstateCenter({ addToast, setActiveTab }) {
  const [summary, setSummary] = useState(null);
  const [graph, setGraph] = useState({ systems: [], edges: [], health: [] });
  const [detail, setDetail] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [owner, setOwner] = useState('');
  const [tags, setTags] = useState('');

  const systemsById = useMemo(() => new Map(graph.systems.map((system) => [system.id, system])), [graph.systems]);
  const grouped = useMemo(() => groupSystems(graph.systems), [graph.systems]);
  const selectedHealth = useMemo(() => {
    if (!selectedId) return null;
    return graph.health.find((item) => item.systemId === selectedId) || null;
  }, [graph.health, selectedId]);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [nextSummary, nextGraph] = await Promise.all([fetchEstateSummary(), fetchEstateGraph()]);
      setSummary(nextSummary);
      setGraph(nextGraph);
      if (!selectedId && nextGraph.systems.length > 0) {
        setSelectedId(nextGraph.systems[0].id);
      }
    } catch (err) {
      setError(err.message || 'Failed to load AI Estate Graph.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      load();
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedId) {
      return;
    }
    let mounted = true;
    fetchEstateSystem(selectedId)
      .then((payload) => {
        if (!mounted) return;
        setDetail(payload);
        setOwner(payload.system.owner || '');
        setTags((payload.system.tags || []).join(', '));
      })
      .catch((err) => {
        if (!mounted) return;
        setError(err.message || 'Failed to load system detail.');
      });
    return () => {
      mounted = false;
    };
  }, [selectedId]);

  const handleRebuild = async () => {
    setBusy(true);
    setError('');
    try {
      const rebuilt = await rebuildEstateGraph();
      const nextSummary = await fetchEstateSummary();
      setGraph(rebuilt);
      setSummary(nextSummary);
      if (rebuilt.systems.length > 0 && !rebuilt.systems.some((system) => system.id === selectedId)) {
        setSelectedId(rebuilt.systems[0].id);
      }
      addToast?.(`Estate graph rebuilt from ${rebuilt.systems.length} discovered system(s).`);
    } catch (err) {
      setError(err.message || 'Estate rebuild failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleSaveMetadata = async (event) => {
    event.preventDefault();
    if (!selectedId) return;
    setBusy(true);
    setError('');
    try {
      const parsedTags = tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean)
        .slice(0, 20);
      const updated = await patchEstateSystem(selectedId, { owner, tags: parsedTags });
      setGraph((current) => ({
        ...current,
        systems: current.systems.map((system) => (system.id === updated.id ? updated : system)),
      }));
      setDetail((current) => (current ? { ...current, system: updated } : current));
      addToast?.('Estate system metadata saved.');
    } catch (err) {
      setError(err.message || 'Failed to save system metadata.');
    } finally {
      setBusy(false);
    }
  };

  const edgeRows = graph.edges.slice(0, 14).map((edge) => ({
    ...edge,
    sourceName: systemsById.get(edge.sourceId)?.name || edge.sourceId,
    targetName: systemsById.get(edge.targetId)?.name || edge.targetId,
  }));

  if (loading) {
    return (
      <div className="estate-empty-state">
        <div className="spinner" />
        <h1 className="page-title">AI Estate Graph</h1>
        <p className="section-subtitle">Building the registry from persisted traces, gateway routes, providers, prompts, RAG tests, and evidence.</p>
      </div>
    );
  }

  const systems = graph.systems || [];
  const selectedSystem = selectedId ? systemsById.get(selectedId) : null;

  return (
    <div className="estate-page">
      <div className="page-intro estate-hero">
        <div>
          <span className="badge badge-success">Governance Registry</span>
          <h1 className="page-title">AI Estate Graph</h1>
          <p className="section-subtitle">
            Discover every AI app, agent, provider, model, prompt, dataset, policy, and evidence record NeuralOps has actually observed.
          </p>
        </div>
        <div className="button-cluster">
          <button className="btn-secondary" onClick={load} disabled={busy}>
            Refresh
          </button>
          <button className="btn-primary" onClick={handleRebuild} disabled={busy}>
            {busy ? 'Rebuilding...' : 'Rebuild Estate Graph'}
          </button>
        </div>
      </div>

      {error && (
        <div className="alert-banner alert-error">
          <strong>Estate graph unavailable</strong>
          <span>{error}</span>
        </div>
      )}

      {systems.length === 0 ? (
        <div className="estate-empty-state card-container">
          <span className="badge badge-warning">No systems discovered</span>
          <h3>No AI estate records exist yet.</h3>
          <p>
            Connect an SDK, route one gateway call, ingest OpenTelemetry GenAI spans, or run a local agent. NeuralOps will then build the graph from real backend records.
          </p>
          <div className="button-cluster">
            <button className="btn-primary" onClick={() => setActiveTab?.('Connect')}>Open Connect</button>
            <button className="btn-secondary" onClick={() => setActiveTab?.('Gateway')}>Open Gateway</button>
          </div>
        </div>
      ) : (
        <>
          <section className="summary-grid estate-summary-grid" aria-label="AI estate inventory">
            <div className="stat-card highlight">
              <span className="stat-label">Discovered Systems</span>
              <span className="stat-value">{summary?.totalSystems ?? systems.length}</span>
              <span className="stat-trend positive">from backend evidence</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Apps + Agents</span>
              <span className="stat-value">{(summary?.counts?.app || 0) + (summary?.counts?.agent || 0)}</span>
              <span className="stat-trend">observed workloads</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Providers + Models</span>
              <span className="stat-value">{(summary?.counts?.provider || 0) + (summary?.counts?.model || 0)}</span>
              <span className="stat-trend">routing surface</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Risky Systems</span>
              <span className="stat-value">{summary?.riskySystems ?? systems.filter((system) => ['Critical', 'Major'].includes(system.risk)).length}</span>
              <span className="stat-trend">needs review</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Observed Spend</span>
              <span className="stat-value">{formatCurrency(summary?.totalSpendUsd)}</span>
              <span className="stat-trend">from traces/routes</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Average Latency</span>
              <span className="stat-value">{formatLatency(summary?.avgLatencyMs)}</span>
              <span className="stat-trend">derived aggregate</span>
            </div>
          </section>

          <section className="estate-layout">
            <div className="estate-map card-container">
              <div className="section-header">
                <div>
                  <h3>Dependency Map</h3>
                  <p>App to gateway, provider, model, policy, dataset, and evidence relationships derived from persisted records.</p>
                </div>
                <span className="badge badge-success">{graph.edges.length} edge(s)</span>
              </div>
              <div className="estate-kind-grid">
                {KIND_ORDER.filter((kind) => grouped[kind]?.length).map((kind) => (
                  <div className="estate-kind-column" key={kind}>
                    <div className="estate-kind-title">{KIND_LABELS[kind] || kind}</div>
                    {grouped[kind].slice(0, 8).map((system) => (
                      <button
                        key={system.id}
                        className={`estate-node ${selectedId === system.id ? 'active' : ''}`}
                        onClick={() => setSelectedId(system.id)}
                      >
                        <span className="estate-node-topline">
                          <strong>{system.name}</strong>
                          <span className={`badge ${riskClass(system.risk)}`}>{system.risk}</span>
                        </span>
                        <span className="estate-node-meta">
                          {system.environment} · {system.source} · {formatLatency(system.avgLatencyMs)}
                        </span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </div>

            <aside className="estate-edge-panel card-container">
              <div className="section-header">
                <div>
                  <h3>Latest Edges</h3>
                  <p>Most recent links found across traces, gateway routes, and release evidence.</p>
                </div>
              </div>
              <div className="event-list">
                {edgeRows.map((edge) => (
                  <button
                    className="event-row estate-edge-row"
                    key={edge.id}
                    onClick={() => setSelectedId(edge.sourceId)}
                  >
                    <span className="badge badge-success">{edge.type}</span>
                    <span>
                      <strong>{edge.sourceName}</strong>
                      <p>{edge.label} → {edge.targetName}</p>
                      <small>{edge.evidence}</small>
                    </span>
                    <span className="mono-text">{edge.latestSeen?.slice(0, 10)}</span>
                  </button>
                ))}
              </div>
            </aside>
          </section>

          <section className="estate-detail-panel card-container" aria-label="System Detail">
            <div className="section-header">
              <div>
                <h3>System Detail</h3>
                <p>{selectedSystem ? selectedSystem.name : 'Select a system to inspect owner, risk, relationships, and release readiness.'}</p>
              </div>
              {selectedSystem && <span className={`badge ${healthClass(selectedHealth?.status)}`}>{selectedHealth?.status || 'healthy'}</span>}
            </div>

            {selectedSystem && detail ? (
              <div className="estate-detail-grid">
                <div className="estate-detail-metrics">
                  <div>
                    <span className="meta-label">Kind</span>
                    <strong>{selectedSystem.kind}</strong>
                  </div>
                  <div>
                    <span className="meta-label">Owner</span>
                    <strong>{selectedSystem.owner}</strong>
                  </div>
                  <div>
                    <span className="meta-label">Environment</span>
                    <strong>{selectedSystem.environment}</strong>
                  </div>
                  <div>
                    <span className="meta-label">Risk Score</span>
                    <strong>{selectedSystem.riskScore}/100</strong>
                  </div>
                  <div>
                    <span className="meta-label">Cost</span>
                    <strong>{formatCurrency(selectedSystem.costUsd)}</strong>
                  </div>
                  <div>
                    <span className="meta-label">Eval Score</span>
                    <strong>{Number(selectedSystem.evalScore || 0).toFixed(2)}</strong>
                  </div>
                </div>

                <form className="estate-edit-grid" onSubmit={handleSaveMetadata}>
                  <label>
                    Owner
                    <input value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="AI Platform Oncall" />
                  </label>
                  <label>
                    Tags
                    <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="prod, checkout, guarded" />
                  </label>
                  <button className="btn-primary" type="submit" disabled={busy}>
                    Save Metadata
                  </button>
                </form>

                <div className="estate-drawer-actions">
                  <button className="btn-secondary" onClick={() => setActiveTab?.('Traces')}>Open Traces</button>
                  <button className="btn-secondary" onClick={() => setActiveTab?.('Gateway')}>Open Gateway</button>
                  <button className="btn-secondary" onClick={() => setActiveTab?.('Evidence')}>Open Evidence</button>
                  <button className="btn-secondary" onClick={() => setActiveTab?.('Incidents')}>Open Incidents</button>
                </div>

                <div className="table-wrap">
                  <table className="dense-table">
                    <thead>
                      <tr>
                        <th>Direction</th>
                        <th>Relationship</th>
                        <th>Evidence</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...detail.outgoing.map((edge) => ({ ...edge, direction: 'outgoing' })), ...detail.incoming.map((edge) => ({ ...edge, direction: 'incoming' }))].map((edge) => (
                        <tr key={`${edge.direction}-${edge.id}`}>
                          <td>{edge.direction}</td>
                          <td>{edge.label}</td>
                          <td>{edge.evidence}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <p className="section-subtitle">Select a node above to inspect details.</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
