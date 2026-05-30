import { useEffect, useState } from 'react';
import { fetchAgents } from '../lib/api';

export default function Agents({ addToast }) {
  const [approvalQueue, setApprovalQueue] = useState([
    { id: 'app_101', agent: 'rag_support_agent', session: 'sess_9281', tool: 'fs_write_file', params: "{ path: '/config/rate_limits.json', content: '...' }", risk: 'High' },
    { id: 'app_102', agent: 'code_copilot_agent', session: 'sess_7421', tool: 'run_terminal_command', params: "{ command: 'npm install --force' }", risk: 'Critical' }
  ]);

  const fallbackAgentsList = [
    { id: 'ag_01', name: 'customer_support_agent', status: 'Active', sessions: 14, memory: '1.4GB', sandbox: 'Isolated', health: 'Healthy' },
    { id: 'ag_02', name: 'data_analytics_agent', status: 'Idle', sessions: 2, memory: '240MB', sandbox: 'Isolated', health: 'Healthy' },
    { id: 'ag_03', name: 'dev_automation_bot', status: 'Active', sessions: 8, memory: '890MB', sandbox: 'Unsandboxed', health: 'Warning' }
  ];

  const [agentsList, setAgentsList] = useState(fallbackAgentsList);
  const [dataSource, setDataSource] = useState('loading');

  const activeSessions = [
    { id: 'sess_9281', agent: 'customer_support_agent', duration: '12m 4s', memory: '142MB', warnings: 0, status: 'Executing' },
    { id: 'sess_7421', agent: 'dev_automation_bot', duration: '45m 12s', memory: '412MB', warnings: 2, status: 'Blocked (Pending)' },
    { id: 'sess_0931', agent: 'data_analytics_agent', duration: '1m 20s', memory: '34MB', warnings: 0, status: 'Idle' }
  ];

  useEffect(() => {
    let cancelled = false;

    fetchAgents()
      .then((agents) => {
        if (cancelled) return;
        setAgentsList(agents.map((agent, index) => ({
          id: agent.id,
          name: agent.name,
          status: agent.status === 'healthy' ? 'Active' : agent.status === 'blocked' ? 'Blocked' : 'Degraded',
          sessions: agent.activeSessions,
          memory: index === 0 ? '1.4GB' : index === 1 ? '890MB' : '240MB',
          sandbox: agent.status === 'blocked' ? 'Unsandboxed' : 'Isolated',
          health: agent.status === 'healthy' ? 'Healthy' : 'Warning'
        })));
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

  const handleApproveTool = (id, toolName) => {
    setApprovalQueue(prev => prev.filter(item => item.id !== id));
    addToast(`Approved risky tool call (${toolName}) execution! Dispatching back to runtime sandbox.`, 'success');
  };

  const handleDenyTool = (id, toolName) => {
    setApprovalQueue(prev => prev.filter(item => item.id !== id));
    addToast(`Blocked tool call (${toolName}) execution! Session halted by policy admin.`, 'error');
  };

  return (
    <div className="main-panel">
      {/* Page Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Agent Registry</h1>
          <p className="page-subtitle">
            Monitor autonomous agent sessions, audit runtime memory, sandbox statuses, and approve risky tool calls.
            {dataSource === 'api' ? ' Backend data loaded.' : dataSource === 'fallback' ? ' Offline fallback active.' : ' Loading backend data...'}
          </p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: '24px' }}>
        {/* Left Side: Agent Registry & Active Sessions */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          {/* Registry Grid */}
          <div className="table-container" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <span style={{ fontSize: '15px', fontWeight: '600' }}>Configured AI Agents</span>
            
            <table className="dense-table" style={{ fontSize: '11.5px' }}>
              <thead>
                <tr>
                  <th>Agent ID</th>
                  <th>Status</th>
                  <th>Sessions</th>
                  <th>Memory</th>
                  <th>Sandbox</th>
                  <th>Health</th>
                </tr>
              </thead>
              <tbody>
                {agentsList.map((ag) => (
                  <tr key={ag.id}>
                    <td style={{ fontWeight: 600 }}>{ag.name}</td>
                    <td>
                      <span className={`badge ${ag.status === 'Active' ? 'badge-success' : 'badge-warning'}`}>
                        {ag.status}
                      </span>
                    </td>
                    <td>{ag.sessions}</td>
                    <td className="code-font">{ag.memory}</td>
                    <td>
                      <span className={`badge ${ag.sandbox === 'Isolated' ? 'badge-success' : 'badge-blocked'}`}>
                        {ag.sandbox}
                      </span>
                    </td>
                    <td>
                      <span style={{ fontWeight: 600, color: ag.health === 'Healthy' ? 'var(--color-success)' : 'var(--color-warning)' }}>
                        {ag.health}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Active Sessions */}
          <div className="table-container" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <span style={{ fontSize: '14px', fontWeight: '600' }}>Active Runtime Sessions</span>
            
            <table className="dense-table" style={{ fontSize: '11px' }}>
              <thead>
                <tr>
                  <th>Session ID</th>
                  <th>Agent Name</th>
                  <th>Duration</th>
                  <th>Memory</th>
                  <th>Warnings</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {activeSessions.map((sess) => (
                  <tr key={sess.id}>
                    <td className="code-font">{sess.id}</td>
                    <td>{sess.agent}</td>
                    <td>{sess.duration}</td>
                    <td className="code-font">{sess.memory}</td>
                    <td style={{ fontWeight: 600, color: sess.warnings > 0 ? 'var(--color-error)' : 'var(--text-secondary)' }}>
                      {sess.warnings}
                    </td>
                    <td>
                      <span style={{ 
                        fontWeight: 600, 
                        color: sess.status.includes('Blocked') ? 'var(--color-error)' : 'var(--color-success)' 
                      }}>
                        {sess.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right Side: Risky Tool Approval Queue */}
        <div className="dark-panel-container">
          <div className="dark-panel-title-row">
            <span className="dark-panel-title">Risky Tool Call Approval Queue</span>
            <span className="badge badge-error" style={{ fontSize: '10px' }}>{approvalQueue.length} Pending</span>
          </div>

          <div className="dark-list">
            {approvalQueue.length > 0 ? (
              approvalQueue.map((item) => (
                <div key={item.id} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '12px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '12px', fontWeight: 600, color: '#FFF' }}>
                      {item.agent} ({item.session})
                    </span>
                    <span className={`badge ${item.risk === 'Critical' ? 'badge-error' : 'badge-warning'}`} style={{ fontSize: '8px' }}>
                      {item.risk} Risk
                    </span>
                  </div>

                  <div style={{ fontSize: '11px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <span style={{ color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', fontSize: '9px' }}>Requested Tool</span>
                    <code style={{ background: 'rgba(0,0,0,0.2)', padding: '4px 8px', borderRadius: '4px', color: 'var(--accent-gold)' }}>
                      {item.tool}
                    </code>
                  </div>

                  <div style={{ fontSize: '11px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <span style={{ color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', fontSize: '9px' }}>Parameters</span>
                    <pre style={{ background: 'rgba(0,0,0,0.2)', padding: '8px', borderRadius: '6px', overflowX: 'auto', fontSize: '10px', color: '#FFF', fontFamily: 'var(--font-mono)' }}>
                      {item.params}
                    </pre>
                  </div>

                  <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                    <button 
                      className="btn-primary" 
                      style={{ flex: 1, background: 'var(--accent-gold)', color: 'var(--text-primary)', fontWeight: 600 }}
                      onClick={() => handleApproveTool(item.id, item.tool)}
                    >
                      Approve & Exec
                    </button>
                    <button 
                      className="btn-primary" 
                      style={{ background: 'var(--color-blocked)', color: '#FFF' }}
                      onClick={() => handleDenyTool(item.id, item.tool)}
                    >
                      Deny Call
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <div className="state-container" style={{ background: 'transparent', border: 'none', padding: '20px 0' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-success)', marginBottom: '8px' }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" style={{ width: '24px', height: '24px' }}>
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </span>
                <span style={{ fontWeight: '600', fontSize: '12px', color: '#FFF' }}>Approval queue clear</span>
                <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.4)' }}>No pending agent actions require manual reviews.</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
