import { useEffect, useMemo, useState } from 'react';
import {
  acceptWorkspaceInvite,
  checkAccessPermission,
  createServiceAccount,
  createWorkspaceInvite,
  fetchAccessAudit,
  fetchAccessPolicy,
  fetchServiceAccounts,
  fetchWorkspaceInvites,
  fetchWorkspaceMembers,
  revokeServiceAccount,
  rotateServiceAccount,
  setApiWorkspaceId,
} from '../lib/api';

const permissionLabels = {
  'workspace:read': 'Read workspace',
  'workspace:write': 'Manage members',
  'settings:read': 'Read settings metadata',
  'settings:write': 'Manage API keys and webhooks',
  'provider:write': 'Manage provider credentials',
  'policy:write': 'Manage guardrail policy',
  'gateway:operate': 'Operate gateway',
  'release:gate': 'Run release gates',
  'incident:write': 'Update incidents',
  'automation:write': 'Manage automations',
};

const roleOrder = ['Owner', 'Admin', 'Developer', 'Security', 'Viewer'];

function decisionClass(decision) {
  if (decision === 'allow') return 'badge-success';
  if (decision === 'block') return 'badge-error';
  return 'badge-warning';
}

export default function AccessCenter({ addToast }) {
  const [policy, setPolicy] = useState(null);
  const [members, setMembers] = useState([]);
  const [invites, setInvites] = useState([]);
  const [serviceAccounts, setServiceAccounts] = useState([]);
  const [audit, setAudit] = useState([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('Developer');
  const [serviceName, setServiceName] = useState('');
  const [serviceOwner, setServiceOwner] = useState('Platform Engineering');
  const [serviceEnvironment, setServiceEnvironment] = useState('prod');
  const [serviceScope, setServiceScope] = useState('gateway:invoke');
  const [serviceToken, setServiceToken] = useState('');
  const [acceptToken, setAcceptToken] = useState('');
  const [selectedPermission, setSelectedPermission] = useState('settings:write');
  const [subject, setSubject] = useState('settings.api_keys');
  const [checkResult, setCheckResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const permissions = useMemo(() => {
    if (!policy) return Object.keys(permissionLabels);
    const unique = new Set();
    Object.values(policy.roles).forEach((role) => {
      role.permissions.forEach((permission) => unique.add(permission));
    });
    return Array.from(unique);
  }, [policy]);

  const load = async () => {
    setError('');
    try {
      const [nextPolicy, nextMembers, nextInvites, nextServiceAccounts, nextAudit] = await Promise.all([
        fetchAccessPolicy(),
        fetchWorkspaceMembers(),
        fetchWorkspaceInvites(),
        fetchServiceAccounts(),
        fetchAccessAudit(),
      ]);
      setPolicy(nextPolicy);
      setMembers(nextMembers);
      setInvites(nextInvites);
      setServiceAccounts(nextServiceAccounts);
      setAudit(nextAudit);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Access control data unavailable');
    }
  };

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchAccessPolicy(), fetchWorkspaceMembers(), fetchWorkspaceInvites(), fetchServiceAccounts(), fetchAccessAudit()])
      .then(([nextPolicy, nextMembers, nextInvites, nextServiceAccounts, nextAudit]) => {
        if (cancelled) return;
        setPolicy(nextPolicy);
        setMembers(nextMembers);
        setInvites(nextInvites);
        setServiceAccounts(nextServiceAccounts);
        setAudit(nextAudit);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Access control data unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const runCheck = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await checkAccessPermission({
        permission: selectedPermission,
        subject: subject.trim() || 'manual-check',
      });
      setCheckResult(result);
      addToast(`Access check ${result.decision}: ${result.permission}`, result.allowed ? 'success' : 'warning');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Access check failed');
      addToast('Access check failed.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const createInvite = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const invite = await createWorkspaceInvite({
        email: inviteEmail,
        role: inviteRole,
        expiresInHours: 72,
      });
      setInvites((current) => [invite, ...current.filter((item) => item.id !== invite.id)]);
      setInviteEmail('');
      setInviteRole('Developer');
      addToast(`Invite created for ${invite.email}.`, 'success');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invite creation failed');
      addToast('Invite creation failed.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const acceptInvite = async (event) => {
    event.preventDefault();
    if (!acceptToken.trim()) return;
    setBusy(true);
    setError('');
    try {
      const result = await acceptWorkspaceInvite(acceptToken.trim());
      setApiWorkspaceId(result.workspaceId);
      setAcceptToken('');
      addToast(`Joined workspace ${result.workspaceId}.`, 'success');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invite acceptance failed');
      addToast('Invite acceptance failed.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const createServiceIdentity = async (event) => {
    event.preventDefault();
    if (!serviceName.trim() || !serviceOwner.trim()) return;
    setBusy(true);
    setError('');
    try {
      const result = await createServiceAccount({
        name: serviceName.trim(),
        owner: serviceOwner.trim(),
        environment: serviceEnvironment,
        scopes: [serviceScope],
        expiresInDays: 90,
      });
      setServiceAccounts((current) => [result.serviceAccount, ...current.filter((item) => item.id !== result.serviceAccount.id)]);
      setServiceToken(result.token);
      setServiceName('');
      addToast(`Service account created: ${result.serviceAccount.name}.`, 'success');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Service account creation failed');
      addToast('Service account creation failed.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const rotateServiceIdentity = async (accountId) => {
    setBusy(true);
    setError('');
    try {
      const result = await rotateServiceAccount(accountId);
      setServiceAccounts((current) => current.map((item) => (item.id === accountId ? result.serviceAccount : item)));
      setServiceToken(result.token);
      addToast(`Rotated service account key for ${result.serviceAccount.name}.`, 'success');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Service account rotation failed');
      addToast('Service account rotation failed.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const revokeServiceIdentity = async (accountId) => {
    setBusy(true);
    setError('');
    try {
      const result = await revokeServiceAccount(accountId);
      setServiceAccounts((current) => current.map((item) => (item.id === accountId ? result : item)));
      addToast(`Revoked service account ${result.name}.`, 'warning');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Service account revocation failed');
      addToast('Service account revocation failed.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="main-panel">
      <div className="page-header">
        <div>
          <h1 className="page-title">Access Control</h1>
          <p className="page-subtitle">
            Prove who can change NeuralOps operations. Roles now gate workspace, settings, provider, gateway, release, incident, and automation actions.
          </p>
        </div>
        <button className="btn-primary" onClick={load} disabled={busy}>
          Refresh Access
        </button>
      </div>

      {error && (
        <div className="state-container" style={{ alignItems: 'flex-start', textAlign: 'left' }}>
          <strong>Access data unavailable</strong>
          <span>{error}</span>
        </div>
      )}

      <div className="summary-grid">
        <div className="stat-card highlight">
          <span className="stat-label">Current User</span>
          <strong className="stat-value">{policy?.currentUser.email || 'loading'}</strong>
          <span className="stat-trend positive">{policy?.currentUser.role || 'role pending'}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Workspace</span>
          <strong className="stat-value">{policy?.workspaceId || 'loading'}</strong>
          <span className="stat-trend positive">{members.length} member records</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Permission Surface</span>
          <strong className="stat-value">{permissions.length}</strong>
          <span className="stat-trend positive">enforced backend permissions</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Access Audit</span>
          <strong className="stat-value">{audit.length}</strong>
          <span className="stat-trend positive">recent access decisions</span>
        </div>
      </div>

      <div className="content-grid two-col">
        <div className="card-container">
          <div className="section-header">
            <div>
              <h3>Workspace Invites</h3>
              <p>Invite tokens create membership only after the invited email accepts while authenticated.</p>
            </div>
          </div>
          <form className="form-stack" onSubmit={createInvite}>
            <label>
              Invite Email
              <input type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="engineer@company.com" required />
            </label>
            <label>
              Role
              <select value={inviteRole} onChange={(event) => setInviteRole(event.target.value)}>
                <option value="Admin">Admin</option>
                <option value="Developer">Developer</option>
                <option value="Security">Security</option>
                <option value="Viewer">Viewer</option>
              </select>
            </label>
            <button className="btn-primary" type="submit" disabled={busy}>Create Invite</button>
          </form>
          <div className="event-list" style={{ marginTop: '14px' }}>
            {invites.slice(0, 5).map((invite) => (
              <div className="event-row" key={invite.id}>
                <span className={`badge ${invite.status === 'pending' ? 'badge-warning' : 'badge-success'}`}>{invite.status}</span>
                <div>
                  <strong>{invite.email}</strong>
                  <p>{invite.role} access expires {new Date(invite.expiresAt).toLocaleString()}</p>
                </div>
                <span className="mono-text">{invite.token}</span>
              </div>
            ))}
            {invites.length === 0 && (
              <div className="state-container compact">
                <strong>No invites yet</strong>
                <span>Create an invite to let another authenticated user join this workspace.</span>
              </div>
            )}
          </div>
        </div>

        <div className="dark-panel-container">
          <div className="section-header">
            <div>
              <h3>Accept Invite</h3>
              <p>Paste a workspace invite token while signed in as the invited email.</p>
            </div>
          </div>
          <form className="form-stack" onSubmit={acceptInvite}>
            <label>
              Invite Token
              <input value={acceptToken} onChange={(event) => setAcceptToken(event.target.value)} placeholder="wsi_..." />
            </label>
            <button className="btn-secondary" type="submit" disabled={busy}>Accept Invite + Switch Workspace</button>
          </form>
        </div>
      </div>

      <div className="card-container">
        <div className="section-header">
          <div>
            <h3>Service Account Control</h3>
            <p>Machine identities for SDKs, CI, gateway callers, and automation. Tokens are shown once, stored as hashes, and can be rotated or revoked.</p>
          </div>
          <span className="badge badge-info">{serviceAccounts.length} service accounts</span>
        </div>

        <form className="form-stack" onSubmit={createServiceIdentity} style={{ marginBottom: '16px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px' }}>
            <label>
              Service Name
              <input value={serviceName} onChange={(event) => setServiceName(event.target.value)} placeholder="production-gateway-worker" required />
            </label>
            <label>
              Owner
              <input value={serviceOwner} onChange={(event) => setServiceOwner(event.target.value)} placeholder="Platform Engineering" required />
            </label>
            <label>
              Environment
              <select value={serviceEnvironment} onChange={(event) => setServiceEnvironment(event.target.value)}>
                <option value="prod">Production</option>
                <option value="staging">Staging</option>
                <option value="dev">Development</option>
                <option value="all">All</option>
              </select>
            </label>
            <label>
              Scope
              <select value={serviceScope} onChange={(event) => setServiceScope(event.target.value)}>
                <option value="gateway:invoke">Gateway invoke</option>
                <option value="trace:ingest">Trace ingest</option>
                <option value="trace:read">Trace read</option>
                <option value="admin">Admin</option>
              </select>
            </label>
          </div>
          <button className="btn-primary" type="submit" disabled={busy}>Create Service Account</button>
        </form>

        {serviceToken && (
          <div className="evidence-card" style={{ marginBottom: '14px' }}>
            <span className="meta-label">One-time service token</span>
            <code className="code-font" style={{ wordBreak: 'break-all' }}>{serviceToken}</code>
            <p>This token is stored only as a backend hash. Rotate it if it was copied into the wrong place.</p>
          </div>
        )}

        <div className="table-wrap">
          <table className="dense-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Owner</th>
                <th>Env</th>
                <th>Scopes</th>
                <th>Status</th>
                <th>Keys</th>
                <th>Last Used</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {serviceAccounts.map((account) => (
                <tr key={account.id}>
                  <td><strong>{account.name}</strong></td>
                  <td>{account.owner}</td>
                  <td><span className="badge badge-info">{account.environment}</span></td>
                  <td>
                    <div className="chip-row">
                      {account.scopes.map((scope) => <span className="mini-chip" key={scope}>{scope}</span>)}
                    </div>
                  </td>
                  <td><span className={`badge ${account.status === 'active' ? 'badge-success' : 'badge-error'}`}>{account.status}</span></td>
                  <td>{account.activeKeyCount}/{account.keyCount} active</td>
                  <td>{account.lastUsedAt ? new Date(account.lastUsedAt).toLocaleString() : 'Never'}</td>
                  <td>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                      <button className="btn-secondary" type="button" disabled={busy || account.status !== 'active'} onClick={() => rotateServiceIdentity(account.id)}>Rotate</button>
                      <button className="btn-secondary" type="button" disabled={busy || account.status !== 'active'} onClick={() => revokeServiceIdentity(account.id)}>Revoke</button>
                    </div>
                  </td>
                </tr>
              ))}
              {serviceAccounts.length === 0 && (
                <tr>
                  <td colSpan="8">No service accounts yet. Create one for server-side SDK, gateway, or CI traffic.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="content-grid two-col">
        <div className="card-container">
          <div className="section-header">
            <div>
              <h3>Role Permission Matrix</h3>
              <p>Backend-enforced permissions for each workspace role.</p>
            </div>
          </div>
          <div className="table-wrap">
            <table className="dense-table">
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Permissions</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {roleOrder.map((roleName) => {
                  const role = policy?.roles?.[roleName];
                  if (!role) return null;
                  return (
                    <tr key={roleName}>
                      <td><strong>{role.role}</strong></td>
                      <td>
                        <div className="chip-row">
                          {role.permissions.map((permission) => (
                            <span className="mini-chip" key={permission}>
                              {permissionLabels[permission] || permission}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td>{role.description}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="dark-panel-container">
          <div className="section-header">
            <div>
              <h3>Permission Simulator</h3>
              <p>Run the same access decision path used by protected backend endpoints.</p>
            </div>
            {checkResult && (
              <span className={`badge ${decisionClass(checkResult.decision)}`}>
                {checkResult.decision}
              </span>
            )}
          </div>
          <div className="form-stack">
            <label>
              Permission
              <select value={selectedPermission} onChange={(event) => setSelectedPermission(event.target.value)}>
                {permissions.map((permission) => (
                  <option key={permission} value={permission}>
                    {permissionLabels[permission] || permission}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Subject
              <input value={subject} onChange={(event) => setSubject(event.target.value)} />
            </label>
            <button className="btn-primary" onClick={runCheck} disabled={busy}>
              Run Permission Check
            </button>
          </div>
          {checkResult && (
            <div className="evidence-card">
              <span className="meta-label">Decision</span>
              <h3>{checkResult.allowed ? 'Allowed' : 'Blocked'} for {checkResult.role}</h3>
              <p>{checkResult.reason}</p>
            </div>
          )}
        </div>
      </div>

      <div className="content-grid two-col">
        <div className="card-container">
          <div className="section-header">
            <div>
              <h3>Workspace Members</h3>
              <p>Members loaded from the backend workspace record.</p>
            </div>
          </div>
          <div className="table-wrap">
            <table className="dense-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Access</th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <tr key={member.id}>
                    <td><strong>{member.name}</strong></td>
                    <td>{member.email}</td>
                    <td>{member.role}</td>
                    <td>{member.access}</td>
                  </tr>
                ))}
                {members.length === 0 && (
                  <tr>
                    <td colSpan="4">No workspace members have been loaded yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card-container">
          <div className="section-header">
            <div>
              <h3>Access Audit</h3>
              <p>Allow and block decisions written by the backend access layer.</p>
            </div>
          </div>
          <div className="event-list">
            {audit.slice(0, 8).map((event) => (
              <div className="event-row" key={event.id}>
                <span className={`badge ${decisionClass(event.decision)}`}>{event.decision}</span>
                <div>
                  <strong>{event.subject}</strong>
                  <p>{event.summary}</p>
                </div>
                <span className="mono-text">{event.actor}</span>
              </div>
            ))}
            {audit.length === 0 && (
              <div className="state-container compact">
                <strong>No access decisions yet</strong>
                <span>Run a permission check or attempt a protected action to create audit evidence.</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
