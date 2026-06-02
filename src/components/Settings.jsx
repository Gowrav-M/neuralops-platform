import { useEffect, useState } from 'react';
import { createApiKey, createWebhook, fetchSettings, updateRetention } from '../lib/api';

export default function Settings({ addToast }) {
  const [retentionDays, setRetentionDays] = useState(30);
  const [apiKeys, setApiKeys] = useState([]);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyRole, setNewKeyRole] = useState('Developer');
  const [oneTimeToken, setOneTimeToken] = useState('');

  const [webhooks, setWebhooks] = useState([]);
  const [newWebhookName, setNewWebhookName] = useState('');
  const [newWebhookUrl, setNewWebhookUrl] = useState('');

  const [teamMembers, setTeamMembers] = useState([]);
  const [ssoStatus, setSsoStatus] = useState('Not configured');
  const [billingPlan, setBillingPlan] = useState('Local development');
  const [nextInvoice, setNextInvoice] = useState(null);
  const [dataSource, setDataSource] = useState('loading');

  useEffect(() => {
    let cancelled = false;

    fetchSettings()
      .then((payload) => {
        if (cancelled) return;
        setRetentionDays(payload.retentionDays);
        setApiKeys(payload.apiKeys.map((key) => ({
          id: key.id,
          name: key.name,
          val: `${key.prefix || 'stored'}...${key.id.slice(-4)}`,
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
        setSsoStatus(payload.ssoStatus || 'Not configured');
        setBillingPlan(payload.billingPlan || 'Local development');
        setNextInvoice(payload.nextInvoice || null);
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

  const applySettingsPayload = (payload) => {
    setRetentionDays(payload.retentionDays);
    setApiKeys(payload.apiKeys.map((key) => ({
      id: key.id,
      name: key.name,
      val: `${key.prefix || 'stored'}...${key.id.slice(-4)}`,
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
    setSsoStatus(payload.ssoStatus || 'Not configured');
    setBillingPlan(payload.billingPlan || 'Local development');
    setNextInvoice(payload.nextInvoice || null);
  };

  const handleGenerateKey = async (e) => {
    e.preventDefault();
    if (!newKeyName) {
      addToast('Please enter a name for the API key.', 'error');
      return;
    }
    try {
      const response = await createApiKey({ name: newKeyName, role: newKeyRole });
      applySettingsPayload(response.settings);
      setOneTimeToken(response.token);
      setNewKeyName('');
      addToast(`Backend created API key record: "${newKeyName}".`, 'success');
    } catch {
      setNewKeyName('');
      addToast('Backend unavailable. API key was not created.', 'error');
    }
  };

  const handleCreateWebhook = async (e) => {
    e.preventDefault();
    if (!newWebhookName || !newWebhookUrl) {
      addToast('Please fill in both webhook name and URL.', 'error');
      return;
    }
    try {
      const payload = await createWebhook({ name: newWebhookName, url: newWebhookUrl });
      applySettingsPayload(payload);
      setNewWebhookName('');
      setNewWebhookUrl('');
      addToast(`Backend registered webhook: "${newWebhookName}".`, 'success');
    } catch {
      setNewWebhookName('');
      setNewWebhookUrl('');
      addToast('Backend unavailable. Webhook was not created.', 'error');
    }
  };

  const handleSaveRetention = async () => {
    try {
      const payload = await updateRetention(retentionDays);
      applySettingsPayload(payload);
      addToast(`Backend saved data retention at ${retentionDays} days.`, 'success');
    } catch {
      addToast('Backend unavailable. Retention setting was not saved.', 'error');
    }
  };

  return (
    <div className="main-panel">
      {/* Page Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">
            Configure developer API credentials, webhooks, workspace role access, and platform retention parameters.
            {dataSource === 'api' ? ' Backend connected.' : dataSource === 'fallback' ? ' Backend offline; no local samples shown.' : ' Loading backend data...'}
          </p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))', gap: '24px' }}>
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
                {apiKeys.length === 0 && (
                  <tr>
                    <td colSpan="4" style={{ color: 'var(--text-secondary)' }}>No API keys have been created yet.</td>
                  </tr>
                )}
              </tbody>
            </table>

            {/* Form */}
            <form onSubmit={handleGenerateKey} style={{ display: 'flex', gap: '10px', alignItems: 'flex-end', background: 'rgba(26,26,25,0.015)', padding: '16px', borderRadius: '12px', border: '1px solid var(--border-color)', marginTop: '8px', flexWrap: 'wrap' }}>
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

            {oneTimeToken && (
              <div style={{ marginTop: '10px', padding: '12px', border: '1px solid var(--border-color)', borderRadius: '8px', background: 'var(--bg-hover)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <span style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-secondary)' }}>One-time token</span>
                <code className="code-font" style={{ fontSize: '11px', wordBreak: 'break-all' }}>{oneTimeToken}</code>
                <span style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>Stored as a backend hash. It will not be shown again after refresh.</span>
              </div>
            )}
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
                {webhooks.length === 0 && (
                  <tr>
                    <td colSpan="3" style={{ color: 'var(--text-secondary)' }}>No webhook endpoints have been registered yet.</td>
                  </tr>
                )}
              </tbody>
            </table>

            {/* Form */}
            <form onSubmit={handleCreateWebhook} style={{ display: 'flex', flexDirection: 'column', gap: '10px', background: 'rgba(26,26,25,0.015)', padding: '16px', borderRadius: '12px', border: '1px solid var(--border-color)', marginTop: '8px' }}>
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 }}>
                  <label style={{ fontSize: '10px', fontWeight: 600 }}>Receiver Label</label>
                  <input
                    type="text"
                    className="filter-search-input"
                  placeholder="Webhook receiver name"
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

            <button className="btn-primary" onClick={handleSaveRetention}>
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
                {teamMembers.length === 0 && (
                  <tr>
                    <td colSpan="3" style={{ color: 'var(--text-secondary)' }}>No team member records are configured yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* SSO & Billing state from backend */}
          <div className="card-container" style={{ gap: '12px' }}>
            <span className="card-title">Enterprise SSO & Identity</span>
            <p style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>
              SAML / OIDC authentication settings from the backend workspace configuration.
            </p>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(26,26,25,0.02)', padding: '10px 14px', borderRadius: '8px', border: '1px solid var(--border-color)', fontSize: '11px' }}>
              <span>Single Sign-On (SSO) Status</span>
              <span className="badge badge-warning">{ssoStatus}</span>
            </div>

            <span className="card-title" style={{ marginTop: '10px' }}>Billing & Usage tier</span>
            <p style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>
              Current billing plan is <strong>{billingPlan}</strong>{nextInvoice ? `. Next invoice processing: ${nextInvoice}.` : '. No invoice date is configured.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
