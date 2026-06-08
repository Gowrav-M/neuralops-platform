import { useEffect, useState } from 'react';
import {
  createApiKey,
  createProviderConnection,
  createWebhook,
  createWorkspaceMember,
  deleteWorkspaceMember,
  fetchGatewayRoutes,
  fetchProviderCatalog,
  fetchProviderConnections,
  fetchSettings,
  patchWorkspaceMember,
  testProviderConnection,
  updateRetention,
} from '../lib/api';

export default function Settings({ addToast }) {
  const [retentionDays, setRetentionDays] = useState(30);
  const [apiKeys, setApiKeys] = useState([]);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyRole, setNewKeyRole] = useState('Developer');
  const [newKeyEnvironment, setNewKeyEnvironment] = useState('staging');
  const [newKeyScope, setNewKeyScope] = useState('trace:ingest');
  const [oneTimeToken, setOneTimeToken] = useState('');
  const [providerCatalog, setProviderCatalog] = useState([]);
  const [providerConnections, setProviderConnections] = useState([]);
  const [selectedProviderId, setSelectedProviderId] = useState('openrouter');
  const [providerLabel, setProviderLabel] = useState('OpenRouter');
  const [providerBaseUrl, setProviderBaseUrl] = useState('https://openrouter.ai/api/v1');
  const [providerModel, setProviderModel] = useState('openai/gpt-4o-mini');
  const [providerApiKey, setProviderApiKey] = useState('');
  const [providerEnvironment, setProviderEnvironment] = useState('staging');
  const [providerPriority, setProviderPriority] = useState(20);
  const [testingProviderId, setTestingProviderId] = useState('');
  const [gatewayRoutes, setGatewayRoutes] = useState([]);

  const [webhooks, setWebhooks] = useState([]);
  const [newWebhookName, setNewWebhookName] = useState('');
  const [newWebhookUrl, setNewWebhookUrl] = useState('');

  const [teamMembers, setTeamMembers] = useState([]);
  const [newMemberName, setNewMemberName] = useState('');
  const [newMemberEmail, setNewMemberEmail] = useState('');
  const [newMemberRole, setNewMemberRole] = useState('Developer');
  const [ssoStatus, setSsoStatus] = useState('Not configured');
  const [billingPlan, setBillingPlan] = useState('Local development');
  const [nextInvoice, setNextInvoice] = useState(null);
  const [dataSource, setDataSource] = useState('loading');

  const mapTeamMembers = (members) => members.map((member) => ({
    id: member.id,
    name: member.name,
    email: member.email,
    role: member.role,
    access: member.access || (member.role === 'Viewer' ? 'Read Only' : 'All Workspace')
  }));

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
          environment: key.environment || 'all',
          scopes: key.scopes || ['trace:ingest'],
          created: key.created,
          lastUsedAt: key.lastUsedAt,
          useCount: key.useCount || 0
        })));
        setWebhooks(payload.webhooks.map((webhook) => ({
          id: webhook.id,
          name: webhook.name,
          url: webhook.url,
          status: webhook.status === 'active' ? 'Active' : webhook.status
        })));
        setTeamMembers(mapTeamMembers(payload.teamMembers));
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

  useEffect(() => {
    let cancelled = false;

    Promise.all([fetchProviderCatalog(), fetchProviderConnections(), fetchGatewayRoutes()])
      .then(([catalog, connections, routes]) => {
        if (cancelled) return;
        setProviderCatalog(catalog);
        setProviderConnections(connections);
        setGatewayRoutes(routes);
        const defaultPreset = catalog.find((provider) => provider.id === 'openrouter') || catalog[0];
        if (defaultPreset) {
          setSelectedProviderId(defaultPreset.id);
          setProviderLabel(defaultPreset.label);
          setProviderBaseUrl(defaultPreset.baseUrl);
          setProviderModel(defaultPreset.defaultModel);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setProviderCatalog([]);
        setProviderConnections([]);
        setGatewayRoutes([]);
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
      environment: key.environment || 'all',
      scopes: key.scopes || ['trace:ingest'],
      created: key.created,
      lastUsedAt: key.lastUsedAt,
      useCount: key.useCount || 0
    })));
    setWebhooks(payload.webhooks.map((webhook) => ({
      id: webhook.id,
      name: webhook.name,
      url: webhook.url,
      status: webhook.status === 'active' ? 'Active' : webhook.status
    })));
    setTeamMembers(mapTeamMembers(payload.teamMembers));
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
      const response = await createApiKey({
        name: newKeyName,
        role: newKeyRole,
        environment: newKeyEnvironment,
        scopes: [newKeyScope],
      });
      applySettingsPayload(response.settings);
      setOneTimeToken(response.token);
      setNewKeyName('');
      addToast(`Backend created ${newKeyEnvironment} key with ${newKeyScope} scope.`, 'success');
    } catch {
      setNewKeyName('');
      addToast('Backend unavailable. API key was not created.', 'error');
    }
  };

  const handleProviderPresetChange = (providerId) => {
    const preset = providerCatalog.find((provider) => provider.id === providerId);
    setSelectedProviderId(providerId);
    if (!preset) return;
    setProviderLabel(preset.label);
    setProviderBaseUrl(preset.baseUrl);
    setProviderModel(preset.defaultModel);
    if (preset.authType === 'none') {
      setProviderApiKey('');
    }
  };

  const handleCreateProviderConnection = async (e) => {
    e.preventDefault();
    if (!providerLabel || !providerBaseUrl || !providerModel) {
      addToast('Provider label, base URL, and model are required.', 'error');
      return;
    }
    try {
      const preset = providerCatalog.find((provider) => provider.id === selectedProviderId);
      const connection = await createProviderConnection({
        providerId: selectedProviderId,
        label: providerLabel,
        baseUrl: providerBaseUrl,
        defaultModel: providerModel,
        apiKey: providerApiKey || null,
        environment: providerEnvironment,
        priority: Number(providerPriority),
        supportsChat: preset?.supportsChat ?? true,
        supportsEmbeddings: preset?.supportsEmbeddings ?? false,
        supportsVision: preset?.supportsVision ?? false,
      });
      setProviderConnections((current) => [connection, ...current.filter((item) => item.id !== connection.id)]);
      fetchGatewayRoutes().then(setGatewayRoutes).catch(() => setGatewayRoutes([]));
      setProviderApiKey('');
      addToast(`Provider connection saved: ${connection.label}.`, 'success');
    } catch {
      addToast('Backend rejected the provider connection.', 'error');
    }
  };

  const handleTestProviderConnection = async (connectionId) => {
    setTestingProviderId(connectionId);
    try {
      const result = await testProviderConnection(connectionId);
      setProviderConnections((current) => current.map((item) => (item.id === connectionId ? result.connection : item)));
      addToast(result.ok ? `Provider test passed in ${result.latencyMs}ms.` : `Provider test failed: ${result.message}`, result.ok ? 'success' : 'error');
    } catch {
      addToast('Provider test could not be completed by the backend.', 'error');
    } finally {
      setTestingProviderId('');
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

  const handleAddMember = async (e) => {
    e.preventDefault();
    if (!newMemberName || !newMemberEmail) {
      addToast('Please enter a member name and email.', 'error');
      return;
    }
    try {
      const member = await createWorkspaceMember({
        name: newMemberName,
        email: newMemberEmail,
        role: newMemberRole,
      });
      setTeamMembers((current) => [member, ...current]);
      setNewMemberName('');
      setNewMemberEmail('');
      setNewMemberRole('Developer');
      addToast(`Workspace member ${member.email} was added.`, 'success');
    } catch {
      addToast('Backend rejected the workspace member change.', 'error');
    }
  };

  const handleRoleChange = async (memberId, role) => {
    try {
      const member = await patchWorkspaceMember(memberId, { role });
      setTeamMembers((current) => current.map((item) => (item.id === memberId ? member : item)));
      addToast(`Workspace role changed to ${role}.`, 'success');
    } catch {
      addToast('Backend rejected the workspace role change.', 'error');
    }
  };

  const handleRemoveMember = async (memberId) => {
    try {
      await deleteWorkspaceMember(memberId);
      setTeamMembers((current) => current.filter((item) => item.id !== memberId));
      addToast('Workspace member was removed.', 'success');
    } catch {
      addToast('Backend rejected the workspace member removal.', 'error');
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
                  <th>Env</th>
                  <th>Scope</th>
                  <th>Uses</th>
                  <th>Age</th>
                </tr>
              </thead>
              <tbody>
                {apiKeys.map(k => (
                  <tr key={k.id}>
                    <td style={{ fontWeight: 600 }}>{k.name}</td>
                    <td className="code-font">{k.val}</td>
                    <td>{k.role}</td>
                    <td><span className="badge badge-info">{k.environment}</span></td>
                    <td className="code-font">{k.scopes.join(', ')}</td>
                    <td title={k.lastUsedAt || 'Never used'}>{k.useCount}</td>
                    <td>{k.created}</td>
                  </tr>
                ))}
                {apiKeys.length === 0 && (
                  <tr>
                    <td colSpan="7" style={{ color: 'var(--text-secondary)' }}>No API keys have been created yet.</td>
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

              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 }}>
                <label style={{ fontSize: '10px', fontWeight: 600 }}>Environment</label>
                <select
                  className="filter-select"
                  value={newKeyEnvironment}
                  onChange={(e) => setNewKeyEnvironment(e.target.value)}
                >
                  <option value="staging">Staging</option>
                  <option value="prod">Production</option>
                  <option value="dev">Development</option>
                  <option value="all">All</option>
                </select>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 }}>
                <label style={{ fontSize: '10px', fontWeight: 600 }}>Permission Scope</label>
                <select
                  className="filter-select"
                  value={newKeyScope}
                  onChange={(e) => setNewKeyScope(e.target.value)}
                >
                  <option value="trace:ingest">Trace Ingest</option>
                  <option value="trace:read">Trace Read</option>
                  <option value="admin">Admin</option>
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

          <div className="card-container">
            <span className="card-title">AI Provider Gateway Connections</span>
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
              Connect live model providers and OpenAI-compatible gateways. Secrets stay on the backend; the browser only receives redacted key previews.
            </p>

            <table className="dense-table" style={{ fontSize: '11px', marginTop: '6px' }}>
              <thead>
                <tr>
                  <th>Connection</th>
                  <th>Env</th>
                  <th>Model</th>
                  <th>Status</th>
                  <th>Key</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {providerConnections.map((connection) => (
                  <tr key={connection.id}>
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                        <span style={{ fontWeight: 700 }}>{connection.label}</span>
                        <span className="code-font" style={{ color: 'var(--text-secondary)', maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{connection.baseUrl}</span>
                      </div>
                    </td>
                    <td><span className="badge badge-info">{connection.environment}</span></td>
                    <td className="code-font">{connection.defaultModel}</td>
                    <td>
                      <span className={`badge ${connection.lastStatus === 'healthy' ? 'badge-success' : connection.lastStatus === 'failed' || connection.lastStatus === 'not_configured' ? 'badge-danger' : 'badge-warning'}`}>
                        {connection.lastStatus}
                      </span>
                    </td>
                    <td className="code-font">{connection.keyPreview || 'local/no-key'}</td>
                    <td>
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={testingProviderId === connection.id}
                        onClick={() => handleTestProviderConnection(connection.id)}
                      >
                        {testingProviderId === connection.id ? 'Testing...' : 'Test'}
                      </button>
                    </td>
                  </tr>
                ))}
                {providerConnections.length === 0 && (
                  <tr>
                    <td colSpan="6" style={{ color: 'var(--text-secondary)' }}>
                      No live provider connections are saved yet. Local deterministic agent mode remains available.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            <form onSubmit={handleCreateProviderConnection} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px', background: 'rgba(26,26,25,0.015)', padding: '16px', borderRadius: '12px', border: '1px solid var(--border-color)', marginTop: '8px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '10px', fontWeight: 600 }}>Provider Preset</label>
                <select
                  className="filter-select"
                  value={selectedProviderId}
                  onChange={(e) => handleProviderPresetChange(e.target.value)}
                >
                  {providerCatalog.map((provider) => (
                    <option key={provider.id} value={provider.id}>{provider.label}</option>
                  ))}
                  {providerCatalog.length === 0 && <option value="custom">Custom OpenAI-Compatible Endpoint</option>}
                </select>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '10px', fontWeight: 600 }}>Connection Label</label>
                <input
                  type="text"
                  className="filter-search-input"
                  value={providerLabel}
                  onChange={(e) => setProviderLabel(e.target.value)}
                  placeholder="e.g. Production OpenRouter"
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', gridColumn: '1 / -1' }}>
                <label style={{ fontSize: '10px', fontWeight: 600 }}>Base URL</label>
                <input
                  type="text"
                  className="filter-search-input"
                  value={providerBaseUrl}
                  onChange={(e) => setProviderBaseUrl(e.target.value)}
                  placeholder="https://provider.example.com/v1"
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '10px', fontWeight: 600 }}>Default Model</label>
                <input
                  type="text"
                  className="filter-search-input"
                  value={providerModel}
                  onChange={(e) => setProviderModel(e.target.value)}
                  placeholder="provider/model-name"
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '10px', fontWeight: 600 }}>Server API Key</label>
                <input
                  type="password"
                  className="filter-search-input"
                  value={providerApiKey}
                  onChange={(e) => setProviderApiKey(e.target.value)}
                  placeholder="Stored encrypted on backend"
                  autoComplete="off"
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '10px', fontWeight: 600 }}>Environment</label>
                <select
                  className="filter-select"
                  value={providerEnvironment}
                  onChange={(e) => setProviderEnvironment(e.target.value)}
                >
                  <option value="staging">Staging</option>
                  <option value="prod">Production</option>
                  <option value="dev">Development</option>
                  <option value="all">All</option>
                </select>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '10px', fontWeight: 600 }}>Routing Priority</label>
                <input
                  type="number"
                  min="1"
                  max="999"
                  className="filter-search-input"
                  value={providerPriority}
                  onChange={(e) => setProviderPriority(e.target.value)}
                />
              </div>

              <button type="submit" className="btn-primary" style={{ alignSelf: 'end' }}>
                Save Provider
              </button>
            </form>

            <div style={{ marginTop: '16px', borderTop: '1px solid var(--border-color)', paddingTop: '14px' }}>
              <span className="card-title" style={{ fontSize: '13px' }}>Recent Gateway Route Evidence</span>
              <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                Each gateway request records provider attempts, selected route, policy decision, and failover evidence.
              </p>
              <table className="dense-table" style={{ fontSize: '11px', marginTop: '8px' }}>
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Selected Provider</th>
                    <th>Attempts</th>
                    <th>Trace</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {gatewayRoutes.slice(0, 5).map((route) => (
                    <tr key={route.id}>
                      <td>
                        <span className={`badge ${route.status === 'routed' ? 'badge-success' : route.status === 'failed' || route.status === 'blocked' ? 'badge-danger' : 'badge-warning'}`}>
                          {route.status}
                        </span>
                      </td>
                      <td>{route.selectedProvider?.label || 'none'}</td>
                      <td>
                        <span className="code-font">
                          {route.attempts.length ? route.attempts.map((attempt) => `${attempt.provider.label}:${attempt.status}`).join(' -> ') : 'no provider attempts'}
                        </span>
                      </td>
                      <td className="code-font">{route.traceId || 'not traced'}</td>
                      <td>{new Date(route.generatedAt).toLocaleTimeString()}</td>
                    </tr>
                  ))}
                  {gatewayRoutes.length === 0 && (
                    <tr>
                      <td colSpan="5" style={{ color: 'var(--text-secondary)' }}>
                        No gateway routes have been recorded yet. Route a server-side LLM call through the Policy Gateway to create evidence.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
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
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: 0 }}>
              These members are stored in the backend workspace record and every change writes an audit event.
            </p>

            <table className="dense-table" style={{ fontSize: '11px' }}>
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Role</th>
                  <th>Workspace Access</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {teamMembers.map(tm => (
                  <tr key={tm.id || tm.email}>
                    <td style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <span style={{ fontWeight: 600 }}>{tm.name}</span>
                      <span style={{ color: 'var(--text-secondary)', fontSize: '10px' }}>{tm.email}</span>
                    </td>
                    <td>
                      <select
                        className="filter-select"
                        aria-label={`Role for ${tm.email}`}
                        value={tm.role}
                        onChange={(e) => handleRoleChange(tm.id, e.target.value)}
                      >
                        <option value="Owner">Owner</option>
                        <option value="Admin">Admin</option>
                        <option value="Developer">Developer</option>
                        <option value="Security">Security</option>
                        <option value="Viewer">Viewer</option>
                      </select>
                    </td>
                    <td className="code-font">{tm.access}</td>
                    <td>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => handleRemoveMember(tm.id)}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
                {teamMembers.length === 0 && (
                  <tr>
                    <td colSpan="4" style={{ color: 'var(--text-secondary)' }}>No team member records are configured yet.</td>
                  </tr>
                )}
              </tbody>
            </table>

            <form onSubmit={handleAddMember} className="settings-member-form">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '10px', fontWeight: 600 }}>Member Name</label>
                <input
                  type="text"
                  className="filter-search-input"
                  placeholder="e.g. Trust Engineering"
                  value={newMemberName}
                  onChange={(e) => setNewMemberName(e.target.value)}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '10px', fontWeight: 600 }}>Email</label>
                <input
                  type="email"
                  className="filter-search-input"
                  placeholder="trust@example.com"
                  value={newMemberEmail}
                  onChange={(e) => setNewMemberEmail(e.target.value)}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '10px', fontWeight: 600 }}>Role</label>
                <select
                  className="filter-select"
                  value={newMemberRole}
                  onChange={(e) => setNewMemberRole(e.target.value)}
                >
                  <option value="Admin">Admin</option>
                  <option value="Developer">Developer</option>
                  <option value="Security">Security</option>
                  <option value="Viewer">Viewer</option>
                </select>
              </div>
              <button type="submit" className="btn-primary">
                Add Member
              </button>
            </form>
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
