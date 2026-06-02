import { useEffect, useState } from 'react';
import { fetchRagQuality, testRagRetrieval } from '../lib/api';

export default function RAGQuality({ addToast }) {
  const [selectedQueryId, setSelectedQueryId] = useState('');
  const [topK, setTopK] = useState(4);
  const [chunkSize, setChunkSize] = useState(512);
  const [embeddingModel, setEmbeddingModel] = useState('text-embedding-3-large');
  const [reranker, setReranker] = useState('cohere-rerank-v3');

  const [queriesData, setQueriesData] = useState({});
  const [dataSource, setDataSource] = useState('loading');

  const selectedData = queriesData[selectedQueryId] || Object.values(queriesData)[0];

  useEffect(() => {
    let cancelled = false;

    fetchRagQuality()
      .then((items) => {
        if (cancelled) return;
        const nextQueries = Object.fromEntries(items.map((item) => {
          const groundedness = Math.round(item.faithfulness * 100);
          const relevance = Math.round(item.relevance * 100);
          return [item.id, {
            id: item.id,
            query: item.query,
            expected: item.expected,
            actual: item.actual,
            metrics: {
              precision: Math.round((item.precision || 0) * 100),
              recall: Math.round((item.recall || 0) * 100),
              groundedness,
              relevance
            },
            chunks: item.chunks || []
          }];
        }));
        setQueriesData(nextQueries);
        setSelectedQueryId(items[0]?.id || '');
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

  const applyRagRecord = (item) => {
    const groundedness = Math.round(item.faithfulness * 100);
    const relevance = Math.round(item.relevance * 100);
    setQueriesData((prev) => ({
      ...prev,
      [item.id]: {
        id: item.id,
        query: item.query,
        expected: item.expected,
        actual: item.actual,
        metrics: {
          precision: Math.round((item.precision || 0) * 100),
          recall: Math.round((item.recall || 0) * 100),
          groundedness,
          relevance
        },
        chunks: item.chunks || []
      }
    }));
  };

  const handleUpdateRetrieval = async () => {
    try {
      const updated = await testRagRetrieval({
        queryId: selectedData.id,
        topK,
        chunkSize,
        embeddingModel,
        reranker
      });
      applyRagRecord(updated);
      addToast('Backend recalculated retrieval quality for this query.', 'success');
    } catch {
      addToast('Backend unavailable. Retrieval quality was not recalculated.', 'error');
    }
  };

  if (!selectedData) {
    return (
      <div className="main-panel">
        <div className="page-header">
          <div>
            <h1 className="page-title">RAG Quality Inspector</h1>
            <p className="page-subtitle">
              Analyze document retrieval quality, context relevance, precision, and answer groundedness.
              {dataSource === 'api' ? ' Backend connected with no RAG records.' : dataSource === 'fallback' ? ' Backend offline; no local RAG samples are shown.' : ' Loading backend data...'}
            </p>
          </div>
        </div>
        <div className="state-container">
          <span style={{ fontWeight: 600 }}>No RAG evaluation records available</span>
          <span>Start the backend or add RAG records to the configured data store.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="main-panel">
      {/* Page Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">RAG Quality Inspector</h1>
          <p className="page-subtitle">
            Analyze document retrieval quality, context relevance, precision, and answer groundedness.
            {dataSource === 'api' ? ' Backend connected.' : dataSource === 'fallback' ? ' Backend offline; no local samples shown.' : ' Loading backend data...'}
          </p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))', gap: '24px' }}>
        {/* Left Side: Query List & Parameters */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          {/* Query Selection Table */}
          <div className="table-container" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <span style={{ fontSize: '15px', fontWeight: '600' }}>Evaluated Query Log</span>

            <table className="dense-table" style={{ fontSize: '11.5px' }}>
              <thead>
                <tr>
                  <th>Query Text</th>
                  <th>Groundedness</th>
                </tr>
              </thead>
              <tbody>
                {Object.keys(queriesData).map((key) => {
                  const q = queriesData[key];
                  return (
                    <tr
                      key={q.id}
                      onClick={() => setSelectedQueryId(q.id)}
                      style={{ background: selectedQueryId === q.id ? 'rgba(26,26,25,0.03)' : '' }}
                    >
                      <td style={{ fontWeight: 500, maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {q.query}
                      </td>
                      <td style={{
                        fontWeight: 700,
                        color: q.metrics.groundedness >= 90 ? 'var(--color-success)' : 'var(--color-warning)'
                      }}>
                        {(q.metrics.groundedness / 100).toFixed(2)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Retrieval Parameter Controls */}
          <div className="card-container">
            <span className="card-title">Retrieval Controls</span>
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
              Adjust retrieval parameters dynamically to test document scoring.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '4px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', fontWeight: 600 }}>
                  <span>top_k documents</span>
                  <span>{topK}</span>
                </div>
                <input
                  type="range"
                  min="1"
                  max="10"
                  className="canary-range-input"
                  value={topK}
                  onChange={(e) => setTopK(parseInt(e.target.value))}
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', fontWeight: 600 }}>
                  <span>chunk_size (tokens)</span>
                  <span>{chunkSize}</span>
                </div>
                <input
                  type="range"
                  step="128"
                  min="256"
                  max="1024"
                  className="canary-range-input"
                  value={chunkSize}
                  onChange={(e) => setChunkSize(parseInt(e.target.value))}
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '11px', fontWeight: 600 }}>Embedding Model</label>
                <select
                  className="filter-select"
                  value={embeddingModel}
                  onChange={(e) => setEmbeddingModel(e.target.value)}
                >
                  <option value="text-embedding-3-large">text-embedding-3-large</option>
                  <option value="text-embedding-3-small">text-embedding-3-small</option>
                  <option value="cohere-embed-english-v3">cohere-embed-english-v3</option>
                </select>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '11px', fontWeight: 600 }}>Reranking Algorithm</label>
                <select
                  className="filter-select"
                  value={reranker}
                  onChange={(e) => setReranker(e.target.value)}
                >
                  <option value="cohere-rerank-v3">cohere-rerank-v3</option>
                  <option value="bge-reranker-large">bge-reranker-large</option>
                  <option value="none">No Reranker</option>
                </select>
              </div>

              <button className="btn-primary" style={{ marginTop: '8px' }} onClick={handleUpdateRetrieval}>
                Apply & Test Retrieval
              </button>
            </div>
          </div>
        </div>

        {/* Right Side: RAG Metrics, Chunk Table, Expected vs Actual */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          {/* Circular Gauges styled like Onboarding / Time-tracker */}
          <div className="card-container">
            <span className="card-title">Retrieval Quality Indicators</span>

            <div style={{ display: 'flex', justifyContent: 'space-around', alignItems: 'center', marginTop: '10px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
                <div className="circular-gauge-container" style={{ width: '85px', height: '85px' }}>
                  <svg className="circular-gauge-svg">
                    <circle cx="42.5" cy="42.5" r="34" className="gauge-bg" />
                    <circle
                      cx="42.5"
                      cy="42.5"
                      r="34"
                      className={`gauge-fill ${selectedData.metrics.precision >= 80 ? 'success' : 'warning'}`}
                      style={{
                        strokeDasharray: '213.6',
                        strokeDashoffset: (213.6 - (213.6 * selectedData.metrics.precision) / 100).toString()
                      }}
                    />
                  </svg>
                  <div className="gauge-text-overlay">
                    <span className="gauge-value" style={{ fontSize: '17px' }}>{selectedData.metrics.precision}%</span>
                  </div>
                </div>
                <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)' }}>Context Precision</span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
                <div className="circular-gauge-container" style={{ width: '85px', height: '85px' }}>
                  <svg className="circular-gauge-svg">
                    <circle cx="42.5" cy="42.5" r="34" className="gauge-bg" />
                    <circle
                      cx="42.5"
                      cy="42.5"
                      r="34"
                      className={`gauge-fill ${selectedData.metrics.recall >= 80 ? 'success' : 'warning'}`}
                      style={{
                        strokeDasharray: '213.6',
                        strokeDashoffset: (213.6 - (213.6 * selectedData.metrics.recall) / 100).toString()
                      }}
                    />
                  </svg>
                  <div className="gauge-text-overlay">
                    <span className="gauge-value" style={{ fontSize: '17px' }}>{selectedData.metrics.recall}%</span>
                  </div>
                </div>
                <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)' }}>Context Recall</span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
                <div className="circular-gauge-container" style={{ width: '85px', height: '85px' }}>
                  <svg className="circular-gauge-svg">
                    <circle cx="42.5" cy="42.5" r="34" className="gauge-bg" />
                    <circle
                      cx="42.5"
                      cy="42.5"
                      r="34"
                      className={`gauge-fill ${selectedData.metrics.groundedness >= 80 ? 'success' : 'warning'}`}
                      style={{
                        strokeDasharray: '213.6',
                        strokeDashoffset: (213.6 - (213.6 * selectedData.metrics.groundedness) / 100).toString()
                      }}
                    />
                  </svg>
                  <div className="gauge-text-overlay">
                    <span className="gauge-value" style={{ fontSize: '17px' }}>{selectedData.metrics.groundedness}%</span>
                  </div>
                </div>
                <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)' }}>Groundedness</span>
              </div>
            </div>
          </div>

          {/* Expected vs Actual Side-by-Side */}
          <div className="card-container">
            <span className="card-title">Output Assessment</span>

            <div className="diff-viewer-grid">
              <div className="diff-column">
                <span className="diff-column-header">Expected Answer</span>
                <p style={{ fontSize: '11.5px', lineHeight: '1.5', color: 'var(--text-secondary)' }}>
                  {selectedData.expected}
                </p>
              </div>

              <div className="diff-column">
                <span className="diff-column-header" style={{ color: selectedData.metrics.relevance >= 90 ? 'var(--color-success)' : 'var(--color-warning)' }}>
                  Actual Generated Answer
                </span>
                <p style={{ fontSize: '11.5px', lineHeight: '1.5', color: 'var(--text-primary)' }}>
                  {selectedData.actual}
                </p>
              </div>
            </div>
          </div>

          {/* Chunk Ranking Table */}
          <div className="table-container" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <span style={{ fontSize: '14px', fontWeight: '600' }}>Retrieved Chunk Ranking Table</span>

            <table className="dense-table" style={{ fontSize: '11px' }}>
              <thead>
                <tr>
                  <th>Doc Source</th>
                  <th>Similarity Score</th>
                  <th>Extracted Chunk Text</th>
                </tr>
              </thead>
              <tbody>
                {selectedData.chunks.map((chunk) => (
                  <tr key={chunk.id}>
                    <td className="code-font" style={{ fontWeight: 600 }}>{chunk.doc}</td>
                    <td style={{
                      fontWeight: 700,
                      color: chunk.score >= 0.8 ? 'var(--color-success)' : 'var(--color-warning)'
                    }}>
                      {chunk.score.toFixed(2)}
                    </td>
                    <td style={{ color: 'var(--text-secondary)', maxWidth: '280px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {chunk.text}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
