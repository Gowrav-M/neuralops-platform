import { useEffect, useMemo, useState } from 'react';
import {
  checkAccessPermission,
  fetchAccessAudit,
  fetchAccessPolicy,
  fetchWorkspaceMembers,
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
  const [audit, setAudit] = useState([]);
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
      const [nextPolicy, nextMembers, nextAudit] = await Promise.all([
        fetchAccessPolicy(),
        fetchWorkspaceMembers(),
        fetchAccessAudit(),
      ]);
      setPolicy(nextPolicy);
      setMembers(nextMembers);
      setAudit(nextAudit);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Access control data unavailable');
    }
  };

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchAccessPolicy(), fetchWorkspaceMembers(), fetchAccessAudit()])
      .then(([nextPolicy, nextMembers, nextAudit]) => {
        if (cancelled) return;
        setPolicy(nextPolicy);
        setMembers(nextMembers);
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
