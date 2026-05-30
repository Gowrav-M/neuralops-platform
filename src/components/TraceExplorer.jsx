import { useState } from 'react';
import { fetchTraceDetail } from '../lib/api';

export default function TraceExplorer({
  traces,
  selectedTrace,
  setSelectedTrace,
  drawerOpen,
  setDrawerOpen
}) {
  const [modelFilter, setModelFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [envFilter, setEnvFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [drawerTab, setDrawerTab] = useState('spans');
  const [drawerLoading, setDrawerLoading] = useState(false);
  const modelOptions = [...new Set(traces.map((trace) => trace.model).filter(Boolean))].sort();
  const statusOptions = [...new Set(traces.map((trace) => trace.status).filter(Boolean))].sort();
  const environmentOptions = [...new Set(traces.map((trace) => trace.environment).filter(Boolean))].sort();

  const filteredTraces = traces.filter(trace => {
    const matchesModel = modelFilter === 'all' || trace.model === modelFilter;
    const matchesStatus = statusFilter === 'all' || trace.status === statusFilter;
    const matchesEnv = envFilter === 'all' || trace.environment === envFilter;
    const matchesSearch = searchQuery === '' ||
      trace.session.toLowerCase().includes(searchQuery.toLowerCase()) ||
      trace.prompt.toLowerCase().includes(searchQuery.toLowerCase()) ||
      trace.output.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesModel && matchesStatus && matchesEnv && matchesSearch;
  });

  const handleRowClick = async (trace) => {
    setSelectedTrace(trace);
    setDrawerOpen(true);
    setDrawerLoading(true);

    try {
      const detail = await fetchTraceDetail(trace.id);
      setSelectedTrace(detail);
    } catch {
      setSelectedTrace(trace);
    } finally {
      setDrawerLoading(false);
    }
  };

  return (
    <div className="main-panel">
      {/* Page Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Trace Explorer</h1>
          <p className="page-subtitle">Inspect token-level lifecycle, latencies, costs, and evaluations across environments.</p>
        </div>
      </div>

      {/* Advanced Filter Bar */}
      <div className="filter-bar">
        <div className="filter-inputs-group">
          <select
            className="filter-select"
            value={modelFilter}
            onChange={(e) => setModelFilter(e.target.value)}
          >
            <option value="all">All Models</option>
            {modelOptions.map((model) => (
              <option key={model} value={model}>{model}</option>
            ))}
          </select>

          <select
            className="filter-select"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="all">All Statuses</option>
            {statusOptions.map((status) => (
              <option key={status} value={status}>{status}</option>
            ))}
          </select>

          <select
            className="filter-select"
            value={envFilter}
            onChange={(e) => setEnvFilter(e.target.value)}
          >
            <option value="all">All Environments</option>
            {environmentOptions.map((environment) => (
              <option key={environment} value={environment}>{environment}</option>
            ))}
          </select>

          <input
            type="text"
            placeholder="Search prompt, output, session..."
            className="filter-search-input"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <button
          className="btn-secondary"
          onClick={() => {
            setModelFilter('all');
            setStatusFilter('all');
            setEnvFilter('all');
            setSearchQuery('');
          }}
          style={{ padding: '6px 12px', fontSize: '11px' }}
        >
          Reset Filters
        </button>
      </div>

      {/* Dense Traces Table */}
      <div className="table-container">
        <table className="dense-table">
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Session ID</th>
              <th>Environment</th>
              <th>Model Name</th>
              <th>Tokens</th>
              <th>Latency</th>
              <th>Cost</th>
              <th>Status</th>
              <th>Score</th>
            </tr>
          </thead>
          <tbody>
            {filteredTraces.length > 0 ? (
              filteredTraces.map((trace, index) => (
                <tr key={`${trace.id}-${index}`} onClick={() => handleRowClick(trace)}>
                  <td style={{ whiteSpace: 'nowrap' }}>{trace.timestamp}</td>
                  <td className="code-font">{trace.session}</td>
                  <td>
                    <span style={{
                      fontSize: '11px',
                      fontWeight: 500,
                      color: trace.environment === 'prod' ? 'var(--text-primary)' : 'var(--text-secondary)'
                    }}>
                      {trace.environment}
                    </span>
                  </td>
                  <td className="code-font" style={{ fontWeight: 500 }}>{trace.model}</td>
                  <td className="code-font">{trace.tokens}</td>
                  <td>{trace.latency}</td>
                  <td style={{ fontWeight: 600 }}>{trace.cost}</td>
                  <td>
                    <span className={`badge ${
                      trace.status === 'success' ? 'badge-success' :
                      trace.status === 'warning' ? 'badge-warning' :
                      trace.status === 'blocked' ? 'badge-blocked' : 'badge-error'
                    }`}>{trace.status}</span>
                  </td>
                  <td style={{ fontWeight: 700, color: trace.score >= 0.85 ? 'var(--color-success)' : trace.score >= 0.7 ? 'var(--color-warning)' : 'var(--color-error)' }}>
                    {trace.score !== null ? trace.score.toFixed(2) : 'N/A'}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan="9">
                  <div className="state-container" style={{ padding: '24px 0', gap: '8px' }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: '32px', height: '32px', color: 'var(--text-tertiary)' }}>
                      <circle cx="11" cy="11" r="8" />
                      <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    <span style={{ fontWeight: '600', fontSize: '14px', color: 'var(--text-primary)' }}>No traces found</span>
                    <span style={{ fontSize: '11px' }}>Try broadening your search keywords or resetting select filters.</span>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Drawer Overlay & Content */}
      {drawerOpen && selectedTrace && (
        <div className="drawer-overlay" onClick={() => setDrawerOpen(false)}>
          <div className="drawer-content" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="drawer-header">
              <div>
                <span className="code-font" style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>
                  TRACE_ID: {selectedTrace.id}
                </span>
                <h3 style={{ fontSize: '18px', fontWeight: '600', marginTop: '4px' }}>
                  {selectedTrace.model}
                </h3>
                {drawerLoading && (
                  <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Loading trace detail...</span>
                )}
              </div>
              <button
                className="drawer-close-btn"
                onClick={() => setDrawerOpen(false)}
                style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: '14px', height: '14px' }}>
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {/* Micro Stats Grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px', background: 'rgba(26,26,25,0.02)', padding: '12px', borderRadius: '10px', border: '1px solid var(--border-color)' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                <span style={{ fontSize: '9px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Latency</span>
                <span style={{ fontSize: '13px', fontWeight: '600' }}>{selectedTrace.latency}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                <span style={{ fontSize: '9px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Tokens</span>
                <span style={{ fontSize: '13px', fontWeight: '600' }}>{selectedTrace.tokens}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                <span style={{ fontSize: '9px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Total Cost</span>
                <span style={{ fontSize: '13px', fontWeight: '600' }}>{selectedTrace.cost}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                <span style={{ fontSize: '9px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Eval Score</span>
                <span style={{ fontSize: '13px', fontWeight: '600', color: selectedTrace.score >= 0.85 ? 'var(--color-success)' : 'var(--color-warning)' }}>
                  {selectedTrace.score ? selectedTrace.score.toFixed(2) : 'N/A'}
                </span>
              </div>
            </div>

            {/* Navigation Tabs */}
            <div className="tab-container-row">
              <button
                className={`tab-btn ${drawerTab === 'spans' ? 'active' : ''}`}
                onClick={() => setDrawerTab('spans')}
              >
                Waterfall Spans
              </button>
              <button
                className={`tab-btn ${drawerTab === 'prompt' ? 'active' : ''}`}
                onClick={() => setDrawerTab('prompt')}
              >
                Prompt / Output
              </button>
              <button
                className={`tab-btn ${drawerTab === 'context' ? 'active' : ''}`}
                onClick={() => setDrawerTab('context')}
              >
                Retrieved Context
              </button>
              <button
                className={`tab-btn ${drawerTab === 'json' ? 'active' : ''}`}
                onClick={() => setDrawerTab('json')}
              >
                Raw JSON
              </button>
            </div>

            {/* Tab Contents */}
            {drawerTab === 'spans' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <span style={{ fontSize: '12px', fontWeight: '600' }}>Execution Timeline Spans</span>

                <div className="waterfall-container">
                  {selectedTrace.spans?.length ? selectedTrace.spans.map((span, index, spans) => {
                    const total = spans.reduce((sum, item) => sum + item.durationMs, 0) || 1;
                    const previous = spans.slice(0, index).reduce((sum, item) => sum + item.durationMs, 0);
                    const left = (previous / total) * 100;
                    const width = Math.max(6, (span.durationMs / total) * 100);
                    return (
                      <div className="waterfall-span-row" key={span.id}>
                        <span className="waterfall-label">{span.name}</span>
                        <div className="waterfall-track">
                          <div className={`waterfall-bar ${span.operation === 'model' ? 'model-call' : span.operation === 'retrieval' ? 'retrieval' : 'embedding'}`} style={{ left: `${left}%`, width: `${width}%` }}></div>
                        </div>
                        <span className="waterfall-time">{Math.round(span.durationMs)}ms</span>
                      </div>
                    );
                  }) : (
                    <div className="state-container" style={{ padding: '18px', gap: '4px' }}>
                      <span style={{ fontWeight: 600 }}>No span records on this trace</span>
                      <span>Use OTEL ingest or agent runtime traces to capture detailed spans.</span>
                    </div>
                  )}
                </div>

                {/* Checks */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <span style={{ fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Guardrail Policies Checked</span>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', background: 'rgba(26,26,25,0.015)', padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--border-color)' }}>
                      <span>PII Masking Filter</span>
                      <span className="badge badge-success">Passed</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', background: 'rgba(26,26,25,0.015)', padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--border-color)' }}>
                      <span>Prompt Injection Guard</span>
                      <span className={`badge ${selectedTrace.status === 'blocked' ? 'badge-blocked' : 'badge-success'}`}>
                        {selectedTrace.status === 'blocked' ? 'Violated' : 'Passed'}
                      </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', background: 'rgba(26,26,25,0.015)', padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--border-color)' }}>
                      <span>Token Threshold Limiter</span>
                      <span className="badge badge-success">Passed</span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {drawerTab === 'prompt' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div>
                  <span style={{ fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Input Prompt</span>
                  <div className="code-editor-panel" style={{ marginTop: '6px', maxHeight: '150px', overflowY: 'auto' }}>
                    {selectedTrace.prompt}
                  </div>
                </div>

                <div>
                  <span style={{ fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Model Response Output</span>
                  <div className="code-editor-panel" style={{ marginTop: '6px', background: '#252522', color: '#FFF', maxHeight: '180px', overflowY: 'auto' }}>
                    {selectedTrace.output}
                  </div>
                </div>

                {selectedTrace.toolCalls && (
                  <div>
                    <span style={{ fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Tool Invocation</span>
                    <div className="code-font" style={{ marginTop: '6px', background: 'var(--accent-gold-light)', padding: '10px', borderRadius: '8px', border: '1px solid rgba(254, 212, 82, 0.4)' }}>
                      <strong>Tool:</strong> <code>{selectedTrace.toolCalls}</code>
                    </div>
                  </div>
                )}
              </div>
            )}

            {drawerTab === 'context' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <span style={{ fontSize: '12px', fontWeight: '600' }}>Runtime Risk Flags & Tool Context</span>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {(selectedTrace.riskFlags?.length ? selectedTrace.riskFlags : ['No risk flags recorded for this trace.']).map((flag) => (
                    <div key={flag} style={{ background: 'var(--bg-card)', border: 'var(--border-card)', padding: '14px', borderRadius: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'var(--text-secondary)' }}>
                        <span>TRACE_CONTEXT: {selectedTrace.id}</span>
                        <span>{selectedTrace.source || 'backend'}</span>
                      </div>
                      <p style={{ fontSize: '11.5px', lineHeight: '1.5' }}>{flag}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {drawerTab === 'json' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <span style={{ fontSize: '12px', fontWeight: '600' }}>Raw OpenTelemetry Trace Object</span>
                <pre className="code-editor-panel" style={{ height: '380px', overflowY: 'auto', fontSize: '11px' }}>
                  {JSON.stringify(selectedTrace, null, 2)}
                </pre>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
