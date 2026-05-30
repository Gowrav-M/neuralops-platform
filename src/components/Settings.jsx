import { useEffect, useState } from 'react';
import { fetchSettings } from '../lib/api';

export default function Settings({ addToast }) {
  const [retentionDays, setRetentionDays] = useState(30);
  const [apiKeys, setApiKeys] = useState([
    { id: 'key_01', name: 'prod_observability_sync', val: 'no_live_...a8f2', role: 'Full Admin', created: '2 months ago' },
    { id: 'key_02', name: 'dev_sandbox_testing', val: 'no_dev_...1b4c', role: 'Developer', created: '12 days ago' }
  ]);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyRole, setNewKeyRole] = useState('Developer');

  const [webhooks, setWebhooks] = useState([
    { id: 'wh_01', name: 'Slack Alerts Integration', url: 'https://hooks.slack.com/services/...', status: 'Active' }
  ]);
  const [newWebhookName, setNewWebhookName] = useState('');
  const [newWebhookUrl, setNewWebhookUrl] = useState('');

  const [teamMembers, setTeamMembers] = useState([
    { name: 'AI Platform Oncall', email: 'oncall@neuralops.local', role: 'Owner', access: 'All Workspace' },
    { name: 'Trust Engineering', email: 'trust@neuralops.local', role: 'Admin', access: 'All Workspace' },
    { name: 'FinOps', email: 'finops@neuralops.local', role: 'Developer', access: 'Sandbox & Dev' }
  ]);
  const [dataSource, setDataSource] = useState('loading');

  useEffect(() => {
    let cancelled = false;

    fetchSettings()
      .then((payload) => {
        if (cancelled) return;
        setRetentionDays(payload.retentionDays);
        setApiKeys(payload.apiKeys.map((key, index) => ({
          id: key.id,
          name: key.name,
          val: `${index === 0 ? 'no_live' : 'no_dev'}_...${key.id.slice(-4)}`,
          role: key.role,
          created: key.created
        })));
        setWebhooks(payload.webhooks.map((webhook) => ({
          id: webhook.id,
          name: webhook.name,
          url: webhook.url,
          status: webhook.status === 'active' ? 'Active' : webhook.status
        })));
        setTeamMembers(payload.teamMembers.map((member) => ({
          name: member.name,
          email: member.email,
          role: member.role,
          access: member.role === 'Viewer' ? 'Read Only' : 'All Workspace'
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

  const handleGenerateKey = (e) => {
    e.preventDefault();
    if (!newKeyName) {
      addToast('Please enter a name for the API key.', 'error');
      return;
    }
    const randHex = Math.random().toString(36).substring(2, 6) + Math.random().toString(36).substring(2, 6);
    const newKey = {
      id: `key_0${apiKeys.length + 1}`,
      name: newKeyName,
      val: `no_${newKeyRole === 'Full Admin' ? 'live' : 'dev'}_...${randHex}`,
      role: newKeyRole,
      created: 'Just now'
    };
    setApiKeys(prev => [newKey, ...prev]);
    setNewKeyName('');
    addToast(`Successfully generated API Key: "${newKey.name}"!`, 'success');
  };

  const handleCreateWebhook = (e) => {
    e.preventDefault();
    if (!newWebhookName || !newWebhookUrl) {
      addToast('Please fill in both webhook name and URL.', 'error');
      return;
    }
    const newWh = {
      id: `wh_0${webhooks.length + 1}`,
      name: newWebhookName,
      url: newWebhookUrl,
      status: 'Active'
    };
    setWebhooks(prev => [...prev, newWh]);
    setNewWebhookName('');
    setNewWebhookUrl('');
    addToast(`Created Webhook: "${newWh.name}"`, 'success');
  };

  return (
    <div className="main-panel">
      {/* Page Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">
            Configure developer API credentials, webhooks, workspace role access, and platform retention parameters.
            {dataSource === 'api' ? ' Backend data loaded.' : dataSource === 'fallback' ? ' Offline fallback active.' : ' Loading backend data...'}
          </p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '24px' }}>
        {/* Left Side: API Keys & Webhooks */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          {/* API Key Generator Card */}
          <div className="card-container">
            <span className="card-title">Developer API Access Keys</span>
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
              Integrate the NeuralOps SDK in your code by generating client auth tokens.
            </p>

            {/* List */}
            <table className="dense-table" style={{ fontSize: '11px', marginTop: '6px' }}>
              <thead>
                <tr>
                  <th>Key Label</th>
                  <th>Key Value</th>
                  <th>Role</th>
                  <th>Age</th>
                </tr>
              </thead>
              <tbody>
                {apiKeys.map(k => (
                  <tr key={k.id}>
                    <td style={{ fontWeight: 600 }}>{k.name}</td>
                    <td className="code-font">{k.val}</td>
                    <td>{k.role}</td>
                    <td>{k.created}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Form */}
            <form onSubmit={handleGenerateKey} style={{ display: 'flex', gap: '10px', alignItems: 'flex-end', background: 'rgba(26,26,25,0.015)', padding: '16px', borderRadius: '12px', border: '1px solid var(--border-color)', marginTop: '8px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 2 }}>
                <label style={{ fontSize: '10px', fontWeight: 600 }}>Key Description Name</label>
                <input 
                  type="text" 
                  className="filter-search-input" 
                  placeholder="e.g. production_nextjs_server" 
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 }}>
                <label style={{ fontSize: '10px', fontWeight: 600 }}>Access RBAC Role</label>
                <select 
                  className="filter-select"
                  value={newKeyRole}
                  onChange={(e) => setNewKeyRole(e.target.value)}
                >
                  <option value="Developer">Developer</option>
                  <option value="Full Admin">Full Admin</option>
                  <option value="Analyst">Analyst</option>
                </select>
              </div>

              <button type="submit" className="btn-primary">
                Create Token
              </button>
            </form>
          </div>

          {/* Webhooks Config Card */}
          <div className="card-container">
            <span className="card-title">Event-Driven Webhook Endpoints</span>
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
              Subscribe to cost spikes, policy blocks, and LLM regression events.
            </p>

            {/* List */}
            <table className="dense-table" style={{ fontSize: '11px', marginTop: '6px' }}>
              <thead>
                <tr>
                  <th>Receiver Label</th>
                  <th>Webhook Endpoint URL</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {webhooks.map(wh => (
                  <tr key={wh.id}>
                    <td style={{ fontWeight: 600 }}>{wh.name}</td>
                    <td className="code-font" style={{ maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {wh.url}
                    </td>
                    <td>
                      <span className="badge badge-success">{wh.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Form */}
            <form onSubmit={handleCreateWebhook} style={{ display: 'flex', flexDirection: 'column', gap: '10px', background: 'rgba(26,26,25,0.015)', padding: '16px', borderRadius: '12px', border: '1px solid var(--border-color)', marginTop: '8px' }}>
              <div style={{ display: 'flex', gap: '10px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 }}>
                  <label style={{ fontSize: '10px', fontWeight: 600 }}>Receiver Label</label>
                  <input 
                    type="text" 
                    className="filter-search-input" 
                    placeholder="Slack Webhook Channel" 
                    value={newWebhookName}
                    onChange={(e) => setNewWebhookName(e.target.value)}
                  />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 2 }}>
                  <label style={{ fontSize: '10px', fontWeight: 600 }}>Endpoint URL</label>
                  <input 
                    type="text" 
                    className="filter-search-input" 
                    placeholder="https://yourserver.com/webhook" 
                    value={newWebhookUrl}
                    onChange={(e) => setNewWebhookUrl(e.target.value)}
                  />
                </div>
              </div>
              <button type="submit" className="btn-primary" style={{ alignSelf: 'flex-end' }}>
                Register Endpoint
              </button>
            </form>
          </div>
        </div>

        {/* Right Side: Retention, SSO, Team RBAC */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          {/* Data Retention Slider */}
          <div className="card-container">
            <span className="card-title">Telemetry Data Retention Limit</span>
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
              Configure retention timelines for raw prompt strings and vector embedding payloads.
            </p>

            <div className="canary-slider-container" style={{ marginTop: '6px' }}>
              <div className="canary-slider-labels">
                <span>Developer Sandbox</span>
                <span style={{ fontWeight: 700 }}>{retentionDays} Days Retention</span>
              </div>
              <input 
                type="range" 
                min="7" 
                max="90" 
                step="7"
                className="canary-range-input" 
                value={retentionDays}
                onChange={(e) => setRetentionDays(parseInt(e.target.value))}
              />
            </div>
            
            <button className="btn-primary" onClick={() => addToast(`Data retention updated to ${retentionDays} days!`, 'success')}>
              Save Retention Config
            </button>
          </div>

          {/* Team Members List */}
          <div className="table-container" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <span style={{ fontSize: '14px', fontWeight: '600' }}>Active Team Members & Role RBAC</span>
            
            <table className="dense-table" style={{ fontSize: '11px' }}>
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Role</th>
                  <th>Workspace Access</th>
                </tr>
              </thead>
              <tbody>
                {teamMembers.map(tm => (
                  <tr key={tm.email}>
                    <td style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <span style={{ fontWeight: 600 }}>{tm.name}</span>
                      <span style={{ color: 'var(--text-secondary)', fontSize: '10px' }}>{tm.email}</span>
                    </td>
                    <td>{tm.role}</td>
                    <td className="code-font">{tm.access}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* SSO & Billing Placeholders */}
          <div className="card-container" style={{ gap: '12px' }}>
            <span className="card-title">Enterprise SSO & Identity</span>
            <p style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>
              SAML / OIDC authentication settings. Managed at organization tier.
            </p>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(26,26,25,0.02)', padding: '10px 14px', borderRadius: '8px', border: '1px solid var(--border-color)', fontSize: '11px' }}>
              <span>Single Sign-On (SSO) Status</span>
              <span className="badge" style={{ background: '#EAE6DB', color: 'var(--text-secondary)' }}>Placeholder</span>
            </div>

            <span className="card-title" style={{ marginTop: '10px' }}>Billing & Usage tier</span>
            <p style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>
              Current billing plan is <strong>Enterprise Scale</strong>. Next invoice processing: June 15, 2026.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
