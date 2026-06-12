import { useEffect, useState } from 'react';
import {
  createApiKey,
  createDataGovernanceLegalHold,
  createProviderConnection,
  createWebhook,
  createWorkspaceMember,
  deleteWorkspaceMember,
  disableProviderConnection,
  enableProviderConnection,
  fetchProviderCatalog,
  fetchProviderConnections,
  fetchSettings,
  fetchDataGovernanceEvidence,
  fetchDataGovernanceInventory,
  fetchDataGovernanceLegalHolds,
  fetchDataGovernancePolicy,
  patchDataGovernanceLegalHold,
  patchWorkspaceMember,
  rotateProviderConnectionKey,
  runDataGovernancePurge,
  simulateDataGovernancePurge,
  testProviderConnection,
  updateDataGovernancePolicy,
  updateProviderConnection,
  updateRetention,
} from '../lib/api';

export default function Settings({ addToast, onNavigate }) {
  const [retentionDays, setRetentionDays] = useState(30);
  const [governancePolicy, setGovernancePolicy] = useState(null);
  const [governanceInventory, setGovernanceInventory] = useState([]);
  const [legalHolds, setLegalHolds] = useState([]);
  const [governanceEvidence, setGovernanceEvidence] = useState(null);
  const [governanceMode, setGovernanceMode] = useState('monitor');
  const [newHoldName, setNewHoldName] = useState('');
  const [newHoldMatchText, setNewHoldMatchText] = useState('');
  const [newHoldReason, setNewHoldReason] = useState('');
  const [purgeSimulation, setPurgeSimulation] = useState(null);
  const [purgeConfirmation, setPurgeConfirmation] = useState('');
  const [governanceBusy, setGovernanceBusy] = useState(false);
  const [governanceError, setGovernanceError] = useState('');
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
  const [providerLifecycleBusyId, setProviderLifecycleBusyId] = useState('');
  const [editingProviderId, setEditingProviderId] = useState('');
  const [rotatingProviderId, setRotatingProviderId] = useState('');
  const [rotatingProviderKey, setRotatingProviderKey] = useState('');

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

  const mapTeamMembers = (members = []) => {
    const seen = new Set();
    return members
      .filter((member) => {
        const key = `${member.id || ''}:${member.email || ''}`.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((member) => ({
        id: member.id,
        name: member.name,
        email: member.email,
        role: member.role,
        access: member.access || (member.role === 'Viewer' ? 'Read Only' : 'All Workspace')
      }));
  };

  const formatRouteDecision = (value) => (value ? value.replaceAll('_', ' ') : 'not routed');
  const governanceDomains = governancePolicy?.domains || ['traces', 'prompts', 'evidence_reports', 'audit', 'provider_connections'];

  const loadGovernance = async () => {
    setGovernanceError('');
    const [policy, inventory, holds, evidence] = await Promise.all([
      fetchDataGovernancePolicy(),
      fetchDataGovernanceInventory(),
      fetchDataGovernanceLegalHolds(),
      fetchDataGovernanceEvidence(),
    ]);
    setGovernancePolicy(policy);
    setRetentionDays(policy.retentionDays);
    setGovernanceMode(policy.mode || 'monitor');
    setGovernanceInventory(inventory);
    setLegalHolds(holds);
    setGovernanceEvidence(evidence);
  };

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

    const timeout = window.setTimeout(() => {
      loadGovernance()
        .catch((err) => {
          if (cancelled) return;
          setGovernanceError(err instanceof Error ? err.message : 'Data governance API unavailable');
        });
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    Promise.all([fetchProviderCatalog(), fetchProviderConnections()])
      .then(([catalog, connections]) => {
        if (cancelled) return;
        setProviderCatalog(catalog);
        setProviderConnections(connections);
        const defaultPreset = catalog.find((provider) => provider.id === 'openrouter') || catalog[0];
        if (defaultPreset) {
          setSelectedProviderId((current) => current || defaultPreset.id);
          setProviderLabel((current) => current || defaultPreset.label);
          setProviderBaseUrl((current) => current || defaultPreset.baseUrl);
          setProviderModel((current) => current || defaultPreset.defaultModel);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setProviderCatalog([]);
        setProviderConnections([]);
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
      const payload = {
        providerId: selectedProviderId,
        label: providerLabel,
        baseUrl: providerBaseUrl,
        defaultModel: providerModel,
        environment: providerEnvironment,
        priority: Number(providerPriority),
        supportsChat: preset?.supportsChat ?? true,
        supportsEmbeddings: preset?.supportsEmbeddings ?? false,
        supportsVision: preset?.supportsVision ?? false,
      };
      const connection = editingProviderId
        ? await updateProviderConnection(editingProviderId, payload)
        : await createProviderConnection({ ...payload, apiKey: providerApiKey || null });
      setProviderConnections((current) => [connection, ...current.filter((item) => item.id !== connection.id)]);
      setProviderApiKey('');
      setEditingProviderId('');
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

  const startEditProviderConnection = (connection) => {
    setEditingProviderId(connection.id);
    setSelectedProviderId(connection.providerId);
    setProviderLabel(connection.label);
    setProviderBaseUrl(connection.baseUrl);
    setProviderModel(connection.defaultModel);
    setProviderEnvironment(connection.environment);
    setProviderPriority(connection.priority);
    setProviderApiKey('');
  };

  const handleDisableProviderConnection = async (connection) => {
    setProviderLifecycleBusyId(connection.id);
    try {
      const disabled = await disableProviderConnection(connection.id, `Disabled from Settings for ${connection.environment} gateway operations.`);
      setProviderConnections((current) => current.map((item) => (item.id === disabled.id ? disabled : item)));
      addToast(`Provider disabled: ${disabled.label}.`, 'warning');
    } catch {
      addToast('Provider disable failed.', 'error');
    } finally {
      setProviderLifecycleBusyId('');
    }
  };

  const handleEnableProviderConnection = async (connection) => {
    setProviderLifecycleBusyId(connection.id);
    try {
      const enabled = await enableProviderConnection(connection.id);
      setProviderConnections((current) => current.map((item) => (item.id === enabled.id ? enabled : item)));
      addToast(`Provider enabled: ${enabled.label}. Test it before production routing.`, 'success');
    } catch {
      addToast('Provider enable failed.', 'error');
    } finally {
      setProviderLifecycleBusyId('');
    }
  };

  const handleRotateProviderConnection = async (connection) => {
    if (!rotatingProviderKey) {
      addToast('Enter the replacement provider key before rotating.', 'error');
      return;
    }
    setProviderLifecycleBusyId(connection.id);
    try {
      const rotated = await rotateProviderConnectionKey(connection.id, rotatingProviderKey);
      setProviderConnections((current) => current.map((item) => (item.id === rotated.id ? rotated : item)));
      setRotatingProviderId('');
      setRotatingProviderKey('');
      addToast(`Provider key rotated for ${rotated.label}. Test must pass before routing resumes.`, 'warning');
    } catch {
      addToast('Provider key rotation failed.', 'error');
    } finally {
      setProviderLifecycleBusyId('');
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
    setGovernanceBusy(true);
    setGovernanceError('');
    try {
      const payload = await updateRetention(retentionDays);
      applySettingsPayload(payload);
      const policy = await updateDataGovernancePolicy({
        retentionDays: Number(retentionDays),
        domains: governanceDomains,
        mode: governanceMode,
      });
      setGovernancePolicy(policy);
      await loadGovernance();
      addToast(`Backend saved governance policy at ${retentionDays} days.`, 'success');
    } catch (err) {
      setGovernanceError(err instanceof Error ? err.message : 'Retention setting was not saved.');
      addToast('Backend unavailable. Governance policy was not saved.', 'error');
    } finally {
      setGovernanceBusy(false);
    }
  };

  const handleCreateLegalHold = async (e) => {
    e.preventDefault();
    if (!newHoldName || !newHoldReason) {
      addToast('Legal hold name and reason are required.', 'error');
      return;
    }
    setGovernanceBusy(true);
    setGovernanceError('');
    try {
      await createDataGovernanceLegalHold({
        name: newHoldName,
        domains: governanceDomains,
        matchText: newHoldMatchText,
        reason: newHoldReason,
      });
      setNewHoldName('');
      setNewHoldMatchText('');
      setNewHoldReason('');
      await loadGovernance();
      addToast('Legal hold created and audited.', 'success');
    } catch (err) {
      setGovernanceError(err instanceof Error ? err.message : 'Legal hold was not created.');
      addToast('Backend rejected the legal hold.', 'error');
    } finally {
      setGovernanceBusy(false);
    }
  };

  const handleReleaseLegalHold = async (holdId) => {
    setGovernanceBusy(true);
    setGovernanceError('');
    try {
      await patchDataGovernanceLegalHold(holdId, { status: 'released' });
      await loadGovernance();
      addToast('Legal hold released and audited.', 'success');
    } catch (err) {
      setGovernanceError(err instanceof Error ? err.message : 'Legal hold was not released.');
      addToast('Backend rejected the legal hold update.', 'error');
    } finally {
      setGovernanceBusy(false);
    }
  };

  const handleSimulatePurge = async () => {
    setGovernanceBusy(true);
    setGovernanceError('');
    setPurgeConfirmation('');
    try {
      const simulation = await simulateDataGovernancePurge({ domains: governanceDomains });
      setPurgeSimulation(simulation);
      await loadGovernance();
      addToast(`Purge simulation found ${simulation.eligibleRecords} eligible record(s).`, 'success');
    } catch (err) {
      setGovernanceError(err instanceof Error ? err.message : 'Purge simulation failed.');
      addToast('Purge simulation failed.', 'error');
    } finally {
      setGovernanceBusy(false);
    }
  };

  const handleRunPurge = async () => {
    if (!purgeSimulation) return;
    setGovernanceBusy(true);
    setGovernanceError('');
    try {
      const job = await runDataGovernancePurge({
        simulationId: purgeSimulation.id,
        confirmation: purgeConfirmation,
      });
      setPurgeSimulation(null);
      setPurgeConfirmation('');
      await loadGovernance();
      addToast(`Confirmed purge deleted ${job.deletedRecords} eligible record(s).`, job.deletedRecords ? 'error' : 'success');
    } catch (err) {
      setGovernanceError(err instanceof Error ? err.message : 'Confirmed purge failed.');
      addToast('Confirmed purge was rejected.', 'error');
    } finally {
      setGovernanceBusy(false);
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
      setTeamMembers((current) => mapTeamMembers([member, ...current]));
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

  const governanceTotals = governanceInventory.reduce(
    (totals, domain) => ({
      totalRecords: totals.totalRecords + (domain.totalRecords || 0),
      eligibleRecords: totals.eligibleRecords + (domain.eligibleRecords || 0),
      protectedRecords: totals.protectedRecords + (domain.protectedRecords || 0),
    }),
    { totalRecords: 0, eligibleRecords: 0, protectedRecords: 0 }
  );
  const activeLegalHoldCount = legalHolds.filter((hold) => hold.status === 'active').length;

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
                  <th>Lifecycle</th>
                  <th>Health</th>
                  <th>Key</th>
                  <th>Last Route</th>
                  <th>Actions</th>
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
                      <span className={`badge ${connection.status === 'active' ? 'badge-success' : connection.status === 'disabled' || connection.status === 'revoked' ? 'badge-danger' : 'badge-warning'}`}>
                        {connection.status || 'active'}
                      </span>
                    </td>
                    <td>
                      <span className={`badge ${connection.lastStatus === 'healthy' ? 'badge-success' : connection.lastStatus === 'failed' || connection.lastStatus === 'not_configured' ? 'badge-danger' : 'badge-warning'}`}>
                        {connection.lastStatus}
                      </span>
                    </td>
                    <td className="code-font">{connection.keyPreview || 'local/no-key'}</td>
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                        <span>{formatRouteDecision(connection.lastRouteDecision)}</span>
                        <span className="code-font" style={{ color: 'var(--text-secondary)' }}>{connection.lastUsedAt || connection.rotatedAt || connection.disabledAt || 'no lifecycle event'}</span>
                      </div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={testingProviderId === connection.id}
                        onClick={() => handleTestProviderConnection(connection.id)}
                      >
                        {testingProviderId === connection.id ? 'Testing...' : 'Test'}
                      </button>
                        <button
                          type="button"
                          className="btn-secondary"
                          disabled={providerLifecycleBusyId === connection.id}
                          onClick={() => startEditProviderConnection(connection)}
                        >
                          Edit
                        </button>
                        {connection.status === 'disabled' || connection.status === 'revoked' || connection.status === 'rotating' ? (
                          <button
                            type="button"
                            className="btn-secondary"
                            disabled={providerLifecycleBusyId === connection.id}
                            onClick={() => handleEnableProviderConnection(connection)}
                          >
                            Enable
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn-secondary"
                            disabled={providerLifecycleBusyId === connection.id}
                            onClick={() => handleDisableProviderConnection(connection)}
                          >
                            Disable
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn-secondary"
                          disabled={providerLifecycleBusyId === connection.id}
                          onClick={() => {
                            setRotatingProviderId((current) => (current === connection.id ? '' : connection.id));
                            setRotatingProviderKey('');
                          }}
                        >
                          Rotate
                        </button>
                      </div>
                      {rotatingProviderId === connection.id && (
                        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 1fr) auto', gap: '6px', marginTop: '8px' }}>
                          <input
                            type="password"
                            className="filter-search-input"
                            value={rotatingProviderKey}
                            onChange={(event) => setRotatingProviderKey(event.target.value)}
                            placeholder="new provider key"
                            autoComplete="off"
                          />
                          <button
                            type="button"
                            className="btn-primary"
                            disabled={providerLifecycleBusyId === connection.id}
                            onClick={() => handleRotateProviderConnection(connection)}
                          >
                            Save
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
                {providerConnections.length === 0 && (
                  <tr>
                    <td colSpan="8" style={{ color: 'var(--text-secondary)' }}>
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

              <div style={{ display: 'flex', gap: '8px', alignSelf: 'end', flexWrap: 'wrap' }}>
                <button type="submit" className="btn-primary">
                  {editingProviderId ? 'Update Provider' : 'Save Provider'}
                </button>
                {editingProviderId && (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => {
                      setEditingProviderId('');
                      setProviderApiKey('');
                    }}
                  >
                    Cancel Edit
                  </button>
                )}
              </div>
            </form>

            <div className="settings-handoff-panel">
              <div>
                <span className="card-title" style={{ fontSize: '13px' }}>Gateway operations live in Gateway</span>
                <p>
                  Use this Settings page only for provider secrets and workspace configuration. Routing evidence,
                  budgets, cache state, provider health, and cost suggestions are managed from the Gateway page.
                </p>
              </div>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => onNavigate?.('Gateway')}
              >
                Open Gateway
              </button>
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
          {/* Data Governance */}
          <div className="card-container" style={{ gap: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div>
                <span className="card-title">Data Governance</span>
                <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '6px 0 0' }}>
                  Inventory retained AI records, protect legal-hold data, simulate deletion, and audit confirmed purge jobs.
                </p>
              </div>
              <span className={`badge ${governanceEvidence?.decision === 'allow' ? 'badge-success' : 'badge-error'}`}>
                {governanceEvidence?.decision || 'review'}
              </span>
            </div>

            {governanceError && (
              <div className="alert-banner error" style={{ margin: 0 }}>
                {governanceError}
              </div>
            )}

            <div className="metric-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))' }}>
              <div>
                <span>Total Records</span>
                <strong>{governanceTotals.totalRecords}</strong>
              </div>
              <div>
                <span>Eligible</span>
                <strong>{governanceTotals.eligibleRecords}</strong>
              </div>
              <div>
                <span>Protected</span>
                <strong>{governanceTotals.protectedRecords}</strong>
              </div>
              <div>
                <span>Legal Holds</span>
                <strong>{activeLegalHoldCount}</strong>
              </div>
            </div>

            <div className="canary-slider-container" style={{ marginTop: '0' }}>
              <div className="canary-slider-labels">
                <span>Retention Policy</span>
                <span style={{ fontWeight: 700 }}>{retentionDays} Days</span>
              </div>
              <input
                type="range"
                min="7"
                max="365"
                step="7"
                className="canary-range-input"
                value={retentionDays}
                onChange={(e) => setRetentionDays(parseInt(e.target.value, 10))}
              />
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
                <select className="filter-select" value={governanceMode} onChange={(e) => setGovernanceMode(e.target.value)}>
                  <option value="monitor">Monitor</option>
                  <option value="enforced">Enforced</option>
                </select>
                <button className="btn-primary" onClick={handleSaveRetention} disabled={governanceBusy}>
                  Save Governance Policy
                </button>
              </div>
            </div>

            <div className="table-container" style={{ padding: '14px' }}>
              <span style={{ fontSize: '13px', fontWeight: 700 }}>Inventory By Domain</span>
              <table className="dense-table" style={{ fontSize: '11px', marginTop: '8px' }}>
                <thead>
                  <tr>
                    <th>Domain</th>
                    <th>Total</th>
                    <th>Eligible</th>
                    <th>Protected</th>
                  </tr>
                </thead>
                <tbody>
                  {governanceInventory.slice(0, 8).map((domain) => (
                    <tr key={domain.domain}>
                      <td className="code-font">{domain.domain}</td>
                      <td>{domain.totalRecords}</td>
                      <td>{domain.eligibleRecords}</td>
                      <td>{domain.protectedRecords}</td>
                    </tr>
                  ))}
                  {governanceInventory.length === 0 && (
                    <tr>
                      <td colSpan="4" style={{ color: 'var(--text-secondary)' }}>No governance inventory has loaded yet.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <form onSubmit={handleCreateLegalHold} style={{ display: 'flex', flexDirection: 'column', gap: '10px', border: '1px solid var(--border-color)', borderRadius: '12px', padding: '14px' }}>
              <span style={{ fontSize: '13px', fontWeight: 700 }}>Legal Holds</span>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px' }}>
                <input className="filter-search-input" placeholder="Hold name" value={newHoldName} onChange={(e) => setNewHoldName(e.target.value)} />
                <input className="filter-search-input" placeholder="Match text, case ID, customer, trace marker" value={newHoldMatchText} onChange={(e) => setNewHoldMatchText(e.target.value)} />
                <input className="filter-search-input" placeholder="Reason" value={newHoldReason} onChange={(e) => setNewHoldReason(e.target.value)} />
              </div>
              <button type="submit" className="btn-primary" disabled={governanceBusy}>
                Create Legal Hold
              </button>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {legalHolds.slice(0, 4).map((hold) => (
                  <div key={hold.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center', borderTop: '1px solid var(--border-color)', paddingTop: '8px' }}>
                    <div style={{ minWidth: 0 }}>
                      <strong>{hold.name}</strong>
                      <p style={{ margin: '2px 0 0', color: 'var(--text-secondary)', fontSize: '11px' }}>{hold.reason}</p>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      <span className={`badge ${hold.status === 'active' ? 'badge-warning' : 'badge-success'}`}>{hold.status}</span>
                      {hold.status === 'active' && (
                        <button type="button" className="btn-secondary" onClick={() => handleReleaseLegalHold(hold.id)} disabled={governanceBusy}>
                          Release
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </form>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', border: '1px solid var(--border-color)', borderRadius: '12px', padding: '14px' }}>
              <span style={{ fontSize: '13px', fontWeight: 700 }}>Purge Simulation</span>
              <p style={{ fontSize: '11.5px', color: 'var(--text-secondary)', margin: 0 }}>
                Simulation is non-destructive. Running a purge requires exact confirmation text and legal holds always win.
              </p>
              <button type="button" className="btn-secondary" onClick={handleSimulatePurge} disabled={governanceBusy}>
                Simulate Purge
              </button>
              {purgeSimulation && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <span className="code-font">
                    {purgeSimulation.eligibleRecords} eligible / {purgeSimulation.protectedRecords} protected. Type {purgeSimulation.confirmation}
                  </span>
                  <input className="filter-search-input" placeholder={purgeSimulation.confirmation} value={purgeConfirmation} onChange={(e) => setPurgeConfirmation(e.target.value)} />
                  <button type="button" className="btn-primary" onClick={handleRunPurge} disabled={governanceBusy || purgeConfirmation !== purgeSimulation.confirmation}>
                    Run Confirmed Purge
                  </button>
                </div>
              )}
            </div>
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
                {teamMembers.map((tm, index) => (
                  <tr key={`${tm.id || tm.email}-${index}`}>
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
