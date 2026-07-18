import { useEffect, useMemo, useRef, useState } from 'react';
import {
  activateAgentKillSwitch,
  ApiError,
  approveAgentApproval,
  approveAgentProductionAccess,
  blockAgentApproval,
  blockAgentProductionAccess,
  fetchAgentApprovals,
  fetchAgentIdentities,
  fetchAgentJobs,
  fetchAgentLeases,
  fetchAgentProductionAccessRequests,
  fetchAgentRuns,
  registerAgentIdentity,
  requestAgentProductionAccess,
  revokeAgentApproval,
  revokeAgentIdentity,
  revokeAgentProductionAccess,
  rotateAgentIdentity,
} from '../lib/api';

const EMPTY_REGISTRATION = {
  displayName: '',
  owner: '',
  environment: 'staging',
  riskLevel: 'Major',
  providerAccess: '',
  permissions: '',
};

const EMPTY_DECISION = { reason: '', evidenceHash: '' };
const EVIDENCE_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

export default function Agents({ addToast }) {
  const [identities, setIdentities] = useState([]);
  const [approvals, setApprovals] = useState([]);
  const [leases, setLeases] = useState([]);
  const [productionRequests, setProductionRequests] = useState([]);
  const [runs, setRuns] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [connectionState, setConnectionState] = useState('checking');
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [registration, setRegistration] = useState(EMPTY_REGISTRATION);
  const [credential, setCredential] = useState(null);
  const [decisionTarget, setDecisionTarget] = useState(null);
  const [decision, setDecision] = useState(EMPTY_DECISION);
  const [destructiveTarget, setDestructiveTarget] = useState(null);
  const [destructiveReason, setDestructiveReason] = useState('');
  const [busy, setBusy] = useState('');
  const mounted = useRef(true);

  const loadControlPlane = async ({ retryForMs = 0 } = {}) => {
    const startedAt = Date.now();
    const backoff = [1200, 2400, 4800, 8000, 12000];
    let attempt = 0;
    if (retryForMs > 0 && mounted.current) setConnectionState('checking');

    while (mounted.current) {
      try {
        const [identityItems, approvalItems, leaseItems, accessItems, runItems, jobItems] = await Promise.all([
          fetchAgentIdentities(),
          fetchAgentApprovals(),
          fetchAgentLeases(),
          fetchAgentProductionAccessRequests(),
          fetchAgentRuns(),
          fetchAgentJobs(),
        ]);
        if (!mounted.current) return false;
        setIdentities(identityItems);
        setApprovals(approvalItems);
        setLeases(leaseItems);
        setProductionRequests(accessItems);
        setRuns(runItems.slice(0, 12));
        setJobs(jobItems.slice(0, 12));
        setConnectionState('ready');
        return true;
      } catch (error) {
        const elapsed = Date.now() - startedAt;
        if (retryForMs === 0 || elapsed >= retryForMs || !isRetryableControlError(error)) {
          if (!mounted.current) return false;
          setConnectionState('unavailable');
          addToast?.(`Agent control data unavailable: ${error.message}`, 'error');
          return false;
        }
        setConnectionState('warming');
        const remaining = retryForMs - elapsed;
        await delay(Math.min(backoff[Math.min(attempt, backoff.length - 1)], remaining));
        attempt += 1;
      }
    }
    return false;
  };

  useEffect(() => {
    mounted.current = true;
    const loadTimer = window.setTimeout(() => loadControlPlane({ retryForMs: 90_000 }), 0);
    return () => {
      mounted.current = false;
      window.clearTimeout(loadTimer);
    };
    // The control plane loads once when the route mounts; actions update state atomically.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const posture = useMemo(() => {
    const pending = approvals.filter((item) => item.status === 'pending').length;
    const stopped = identities.filter((item) => ['disabled', 'revoked'].includes(item.status)).length;
    const productionApproved = identities.filter((item) => item.productionAccessStatus === 'approved').length;
    const findings = runs.reduce((count, run) => count + (run.evals || []).filter((item) => item.status !== 'pass').length, 0);
    return { pending, stopped, productionApproved, findings };
  }, [approvals, identities, runs]);

  const handleRegister = async (event) => {
    event.preventDefault();
    setBusy('register');
    try {
      const result = await registerAgentIdentity({
        displayName: registration.displayName.trim(),
        owner: registration.owner.trim(),
        environment: registration.environment,
        riskLevel: registration.riskLevel,
        providerAccess: commaList(registration.providerAccess),
        permissions: commaList(registration.permissions),
        captureMode: 'metadata_only',
      });
      setIdentities((current) => [result.identity, ...current]);
      setCredential({ value: result.credential, identityName: result.identity.displayName });
      setRegistrationOpen(false);
      setRegistration(EMPTY_REGISTRATION);
      addToast?.(`${result.identity.displayName} registered with metadata-only capture.`, 'success');
    } catch (error) {
      addToast?.(`Identity registration failed: ${error.message}`, 'error');
    } finally {
      setBusy('');
    }
  };

  const revealRotatedCredential = async (identity) => {
    setBusy(`rotate:${identity.id}`);
    try {
      const result = await rotateAgentIdentity(identity.id);
      replaceById(setIdentities, result.identity);
      setCredential({ value: result.credential, identityName: result.identity.displayName });
      addToast?.(`Credential rotated for ${identity.displayName}. Existing leases were revoked.`, 'warning');
    } catch (error) {
      addToast?.(`Credential rotation failed: ${error.message}`, 'error');
    } finally {
      setBusy('');
    }
  };

  const requestProduction = async (identity) => {
    setBusy(`production:${identity.id}`);
    try {
      const result = await requestAgentProductionAccess({
        agentId: identity.agentId,
        targetEnvironment: 'prod',
        justification: `Governed production access requested for ${identity.displayName} after pilot evidence review.`,
      });
      setProductionRequests((current) => [result, ...current.filter((item) => item.id !== result.id)]);
      addToast?.(`Production access queued for independent review. Evidence: ${result.evidenceId}.`, 'warning');
    } catch (error) {
      addToast?.(`Production access request failed: ${error.message}`, 'error');
    } finally {
      setBusy('');
    }
  };

  const openDecision = (kind, record) => {
    setDecisionTarget({ kind, record });
    setDecision(EMPTY_DECISION);
  };

  const submitDecision = async (action) => {
    if (!decisionTarget) return;
    const { kind, record } = decisionTarget;
    setBusy(`decision:${record.id}:${action}`);
    try {
      const payload = { reason: decision.reason.trim(), evidenceHash: decision.evidenceHash.trim() };
      let result;
      if (kind === 'approval') {
        const handlers = { approve: approveAgentApproval, block: blockAgentApproval, revoke: revokeAgentApproval };
        result = await handlers[action](record.id, payload);
        replaceById(setApprovals, result);
      } else {
        const handlers = { approve: approveAgentProductionAccess, block: blockAgentProductionAccess, revoke: revokeAgentProductionAccess };
        result = await handlers[action](record.id, payload);
        replaceById(setProductionRequests, result);
        await loadControlPlane();
      }
      setDecisionTarget(null);
      setDecision(EMPTY_DECISION);
      addToast?.(`${kind === 'approval' ? 'Tool action' : 'Production access'} ${pastTense(action)} with audit evidence.`, action === 'approve' ? 'success' : 'warning');
    } catch (error) {
      addToast?.(`Decision failed closed: ${error.message}`, 'error');
    } finally {
      setBusy('');
    }
  };

  const submitDestructiveAction = async () => {
    if (!destructiveTarget) return;
    const { mode, identity } = destructiveTarget;
    setBusy(`${mode}:${identity.id}`);
    try {
      if (mode === 'kill') {
        const result = await activateAgentKillSwitch(identity.id, destructiveReason.trim());
        replaceById(setIdentities, result.identity);
        addToast?.(`Emergency stop active. ${result.revokedLeases} leases revoked; ${result.cancelledJobs} queued jobs cancelled.`, 'warning');
      } else {
        const result = await revokeAgentIdentity(identity.id, destructiveReason.trim());
        replaceById(setIdentities, result);
        addToast?.(`${identity.displayName} and its credential were revoked.`, 'warning');
      }
      setDestructiveTarget(null);
      setDestructiveReason('');
    } catch (error) {
      addToast?.(`${mode === 'kill' ? 'Emergency stop' : 'Revocation'} failed closed: ${error.message}`, 'error');
    } finally {
      setBusy('');
    }
  };

  return (
    <main className="agent-command" aria-busy={['checking', 'warming'].includes(connectionState)}>
      <header className="agent-command__hero">
        <div>
          <span className="agent-command__eyebrow">Supervised agent operations / workspace scope</span>
          <h1 className="page-title">Agent Command Center</h1>
          <p className="page-subtitle">
            Register every agent, bound every tool call, and stop unsafe execution before it leaves your workspace.
            Raw prompts, outputs, arguments, secrets, and files are not retained.
          </p>
        </div>
        <div className="agent-command__hero-actions">
          <span className={`agent-command__signal agent-command__signal--${connectionState}`} role="status">
            <span aria-hidden="true" /> {connectionState === 'ready' ? 'Control plane live' : connectionState === 'checking' ? 'checking' : connectionState === 'warming' ? 'warming · retrying up to 90s' : 'unavailable'}
          </span>
          <button className="agent-command__primary" onClick={() => setRegistrationOpen(true)}>Register external agent</button>
        </div>
      </header>

      <section className="agent-command__metrics" aria-label="Agent posture summary">
        <Metric label="Managed identities" value={identities.length} detail={`${posture.stopped} stopped or revoked`} />
        <Metric label="Pending approvals" value={posture.pending} detail="High-risk actions fail closed" tone={posture.pending ? 'warning' : 'safe'} />
        <Metric label="Production approved" value={posture.productionApproved} detail="Owner or Admin decision" />
        <Metric label="Policy findings" value={posture.findings} detail="From recent persisted runs" tone={posture.findings ? 'danger' : 'safe'} />
      </section>

      <section className="agent-command__section" aria-labelledby="identity-posture-title">
        <div className="agent-command__section-heading">
          <div>
            <span className="agent-command__kicker">Identity perimeter</span>
            <h2 id="identity-posture-title">Live agent posture</h2>
          </div>
          <button className="agent-command__text-button" onClick={() => loadControlPlane({ retryForMs: 90_000 })} disabled={['checking', 'warming'].includes(connectionState)}>Refresh control plane</button>
        </div>

        <div className="agent-command__identity-grid">
          {identities.map((identity, index) => {
            const pendingCount = approvals.filter((item) => item.identityId === identity.id && item.status === 'pending').length;
            const activeLeases = leases.filter((item) => item.identityId === identity.id && item.status === 'active');
            const recentRun = runs.find((run) => [identity.id, identity.agentId].includes(run.agentId));
            return (
              <article className="agent-command__identity" data-identity-id={identity.id} key={identity.id} style={{ '--entry-index': index }}>
                <div className="agent-command__identity-head">
                  <div>
                    <span className="agent-command__identity-id">{identity.agentId}</span>
                    <h3>{identity.displayName}</h3>
                  </div>
                  <Status value={identity.status} />
                </div>

                <dl className="agent-command__boundary-list">
                  <Boundary label="Owner" value={identity.owner} />
                  <Boundary label="Environment" value={identity.environment} />
                  <Boundary label="Risk" value={identity.riskLevel} />
                  <Boundary label="Credential" value={identity.credentialStatus} />
                  <Boundary label="Production" value={identity.productionAccessStatus.replaceAll('_', ' ')} />
                  <Boundary label="Capture" value="Metadata only" />
                  <Boundary label="Active leases" value={`${activeLeases.length} active`} />
                  <Boundary label="Pending approvals" value={String(pendingCount)} />
                  <Boundary label="Recent run" value={recentRun ? `${recentRun.decision} / ${formatTime(recentRun.createdAt)}` : 'No recent run'} />
                </dl>

                <BoundaryChips label="Providers" values={identity.providerAccess} empty="No provider allowed" />
                <BoundaryChips label="Permissions" values={identity.permissions} empty="No tool permission" />

                {identity.killSwitchReason && <p className="agent-command__stop-reason"><strong>Stopped:</strong> {identity.killSwitchReason}</p>}

                <div className="agent-command__identity-actions">
                  <button onClick={() => requestProduction(identity)} disabled={busy !== '' || identity.productionAccessStatus === 'approved'}>
                    {identity.productionAccessStatus === 'approved' ? 'Production approved' : 'Request production'}
                  </button>
                  <button onClick={() => revealRotatedCredential(identity)} disabled={busy !== '' || identity.status === 'revoked'}>Rotate credential</button>
                  <button className="danger" onClick={() => setDestructiveTarget({ mode: 'kill', identity })} disabled={busy !== '' || ['disabled', 'revoked'].includes(identity.status)}>Emergency stop</button>
                  <button className="danger ghost" onClick={() => setDestructiveTarget({ mode: 'revoke', identity })} disabled={busy !== '' || identity.status === 'revoked'}>Revoke identity</button>
                </div>
              </article>
            );
          })}
          {['checking', 'warming'].includes(connectionState) && <LoadingPanel label={connectionState === 'warming' ? 'Backend warming; preserving this read' : 'Checking workspace identities'} />}
          {connectionState === 'ready' && identities.length === 0 && <EmptyPanel title="No governed identities" detail="Register the first external agent to issue a scoped, one-time credential." />}
        </div>
      </section>

      <div className="agent-command__review-grid">
        <section className="agent-command__section" aria-labelledby="approval-title">
          <div className="agent-command__section-heading">
            <div>
              <span className="agent-command__kicker">Human authorization</span>
              <h2 id="approval-title">Tool action approvals</h2>
            </div>
            <span className="agent-command__count">{approvals.filter((item) => item.status === 'pending').length} pending</span>
          </div>
          <div className="agent-command__review-list">
            {approvals.map((item) => (
              <article className="agent-command__review" data-approval-id={item.id} key={item.id}>
                <div className="agent-command__review-head">
                  <div><span>{item.toolCategory}</span><strong>{item.operation}</strong></div>
                  <Status value={item.status} />
                </div>
                <dl>
                  <Boundary label="Identity" value={item.identityId} />
                  <Boundary label="Environment" value={item.environment} />
                  <Boundary label="Requested by" value={item.requestedBy} />
                  <Boundary label="Expires" value={formatTime(item.expiresAt)} />
                  <Boundary label="Idempotency" value={item.idempotencyKey} />
                  <Boundary label="Evidence binding" value={shortHash(item.contentHash)} />
                </dl>
                <button className="agent-command__review-button" onClick={() => openDecision('approval', item)}>
                  {item.status === 'pending' ? 'Review request' : item.status === 'approved' || item.status === 'consumed' ? 'Review or revoke' : 'View decision'}
                </button>
              </article>
            ))}
            {approvals.length === 0 && <EmptyPanel title="Approval queue clear" detail="No persisted high-risk actions are waiting for review." />}
          </div>
        </section>

        <section className="agent-command__section" aria-labelledby="production-title">
          <div className="agent-command__section-heading">
            <div>
              <span className="agent-command__kicker">Environment boundary</span>
              <h2 id="production-title">Production access</h2>
            </div>
            <span className="agent-command__count">{productionRequests.filter((item) => item.status === 'pending_review').length} pending</span>
          </div>
          <div className="agent-command__review-list">
            {productionRequests.map((item) => (
              <article className="agent-command__review" data-production-request-id={item.id} key={item.id}>
                <div className="agent-command__review-head">
                  <div><span>{item.targetEnvironment}</span><strong>{identityName(identities, item.agentId)}</strong></div>
                  <Status value={item.status} />
                </div>
                <p>{item.justification}</p>
                <dl>
                  <Boundary label="Requested by" value={item.requestedBy} />
                  <Boundary label="Evidence" value={item.evidenceId} />
                  <Boundary label="Created" value={formatTime(item.createdAt)} />
                </dl>
                <button className="agent-command__review-button" onClick={() => openDecision('production', item)}>Review production access</button>
              </article>
            ))}
            {productionRequests.length === 0 && <EmptyPanel title="No production requests" detail="Production remains denied until an Owner or Admin approves it." />}
          </div>
        </section>
      </div>

      <section className="agent-command__section" aria-labelledby="lease-title">
        <div className="agent-command__section-heading">
          <div>
            <span className="agent-command__kicker">Short-lived authority</span>
            <h2 id="lease-title">Authorization leases</h2>
          </div>
          <span className="agent-command__count">{leases.filter((item) => item.status === 'active').length} active</span>
        </div>
        <div className="agent-command__evidence-table" role="region" aria-label="Authorization lease posture" tabIndex="0">
          <table>
            <thead><tr><th>Lease</th><th>Identity</th><th>Action / operation</th><th>Risk</th><th>Environment</th><th>Status</th><th>Expires</th></tr></thead>
            <tbody>
              {leases.map((lease) => (
                <tr data-lease-id={lease.id} key={lease.id}>
                  <td>{lease.id}</td>
                  <td>{identityName(identities, lease.identityId)}</td>
                  <td>{lease.action} / {lease.operation}</td>
                  <td>{lease.risk}</td>
                  <td>{lease.environment}</td>
                  <td><Status value={lease.status} /></td>
                  <td>{formatTime(lease.expiresAt)}</td>
                </tr>
              ))}
              {leases.length === 0 && <tr><td colSpan="7">No authorization leases have been issued in this workspace.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="agent-command__section" aria-labelledby="evidence-title">
        <div className="agent-command__section-heading">
          <div>
            <span className="agent-command__kicker">Operational evidence</span>
            <h2 id="evidence-title">Recent runs and queued work</h2>
          </div>
          <span className="agent-command__count">Metadata only</span>
        </div>
        <div className="agent-command__evidence-table" role="region" aria-label="Recent agent evidence" tabIndex="0">
          <table>
            <thead><tr><th>Record</th><th>Agent</th><th>State</th><th>Provider</th><th>Policy findings</th><th>Time</th></tr></thead>
            <tbody>
              {runs.slice(0, 6).map((run) => (
                <tr key={run.id}><td>{run.id}</td><td>{run.agentName || run.agentId}</td><td><Status value={run.decision} /></td><td>{run.provider || 'metadata'}</td><td>{(run.evals || []).filter((item) => item.status !== 'pass').length}</td><td>{formatTime(run.createdAt)}</td></tr>
              ))}
              {jobs.slice(0, 6).map((job) => (
                <tr key={job.id}><td>{job.id}</td><td>{job.request?.agentId}</td><td><Status value={job.status} /></td><td>{job.request?.providerMode || 'queued'}</td><td>{job.error ? 1 : 0}</td><td>{formatTime(job.updatedAt)}</td></tr>
              ))}
              {runs.length + jobs.length === 0 && <tr><td colSpan="6">No recent runtime evidence.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {registrationOpen && (
        <Modal title="Register external agent" onClose={() => setRegistrationOpen(false)}>
          <form className="agent-command__form" onSubmit={handleRegister}>
            <label>Agent name<input aria-label="Agent name" required value={registration.displayName} onChange={(event) => setRegistration({ ...registration, displayName: event.target.value })} /></label>
            <label>Owner<input aria-label="Owner" required value={registration.owner} onChange={(event) => setRegistration({ ...registration, owner: event.target.value })} /></label>
            <div className="agent-command__form-row">
              <label>Environment<select value={registration.environment} onChange={(event) => setRegistration({ ...registration, environment: event.target.value })}><option value="dev">Development</option><option value="staging">Staging</option><option value="prod">Production boundary</option><option value="all">All environments</option></select></label>
              <label>Risk level<select value={registration.riskLevel} onChange={(event) => setRegistration({ ...registration, riskLevel: event.target.value })}><option>Critical</option><option>Major</option><option>Minor</option><option>Low</option></select></label>
            </div>
            <label>Allowed providers<input aria-label="Allowed providers" required value={registration.providerAccess} onChange={(event) => setRegistration({ ...registration, providerAccess: event.target.value })} /><small>Comma-separated provider IDs. Provider keys are never entered here.</small></label>
            <label>Allowed permissions<textarea aria-label="Allowed permissions" required value={registration.permissions} onChange={(event) => setRegistration({ ...registration, permissions: event.target.value })} /><small>Grant the smallest exact tool scopes this agent needs.</small></label>
            <div className="agent-command__privacy-note"><strong>Metadata-only by default.</strong> NeuralOps stores IDs, timing, totals, status, findings, and hashes — not prompts, outputs, tool arguments, secrets, or files.</div>
            <div className="agent-command__modal-actions"><button type="button" onClick={() => setRegistrationOpen(false)}>Cancel</button><button className="primary" disabled={busy === 'register'}>{busy === 'register' ? 'Issuing…' : 'Issue one-time credential'}</button></div>
          </form>
        </Modal>
      )}

      {credential && (
        <Modal title="One-time agent credential" onClose={() => setCredential(null)}>
          <div className="agent-command__credential">
            <p><strong>{credential.identityName}</strong> is registered. This credential will not be shown again.</p>
            <code>{credential.value}</code>
            <p>Store it in the agent runtime secret manager. Never paste it into prompts, logs, chat, or source control.</p>
            <div className="agent-command__modal-actions"><button type="button" onClick={() => copyCredential(credential.value, addToast)}>Copy credential</button><button className="primary" type="button" onClick={() => setCredential(null)}>I saved it — close</button></div>
          </div>
        </Modal>
      )}

      {decisionTarget && (
        <Modal title={decisionTarget.kind === 'approval' ? 'Review tool action' : 'Review production access'} onClose={() => setDecisionTarget(null)}>
          <div className="agent-command__decision-summary">
            <Status value={decisionTarget.record.status} />
            <strong>{decisionTarget.record.operation || identityName(identities, decisionTarget.record.agentId)}</strong>
            <span>Idempotency: {decisionTarget.record.idempotencyKey || decisionTarget.record.id}</span>
          </div>
          {busy.startsWith(`decision:${decisionTarget.record.id}:`) && (
            <p className="agent-command__decision-pending" role="status">Decision pending backend confirmation. Retryable failures reuse the same action, evidence, and idempotency key.</p>
          )}
          <div className="agent-command__form">
            <label>Decision reason<textarea aria-label="Decision reason" required value={decision.reason} onChange={(event) => setDecision({ ...decision, reason: event.target.value })} /></label>
            <label>
              Evidence hash (SHA-256)
              <input
                aria-label="Evidence hash"
                required
                pattern="sha256:[0-9a-f]{64}"
                placeholder={`sha256:${'a'.repeat(64)}`}
                spellCheck={false}
                autoCapitalize="none"
                value={decision.evidenceHash}
                onChange={(event) => setDecision({ ...decision, evidenceHash: event.target.value })}
              />
              <small>Required format: sha256 followed by 64 lowercase hexadecimal characters.</small>
            </label>
            <div className="agent-command__modal-actions agent-command__modal-actions--decisions">
              {decisionTarget.record.status === 'pending' || decisionTarget.record.status === 'pending_review' ? <><button className="danger" onClick={() => submitDecision('block')} disabled={!validDecision(decision) || busy !== ''}>Block action</button><button className="primary" onClick={() => submitDecision('approve')} disabled={!validDecision(decision) || busy !== ''}>Approve action</button></> : null}
              {['approved', 'consumed'].includes(decisionTarget.record.status) && <button className="danger" onClick={() => submitDecision('revoke')} disabled={!validDecision(decision) || busy !== ''}>Revoke approval</button>}
              <button onClick={() => setDecisionTarget(null)}>Close review</button>
            </div>
          </div>
        </Modal>
      )}

      {destructiveTarget && (
        <Modal title={destructiveTarget.mode === 'kill' ? 'Confirm emergency stop' : 'Confirm identity revocation'} onClose={() => setDestructiveTarget(null)}>
          <div className="agent-command__form">
            <p className="agent-command__danger-copy">{destructiveTarget.mode === 'kill' ? 'This immediately disables the agent, revokes active authorization leases, cancels queued jobs, and prevents new runs.' : 'This permanently revokes the credential and all active leases. Register a new identity to restore access.'}</p>
            <label>{destructiveTarget.mode === 'kill' ? 'Emergency stop reason' : 'Revocation reason'}<textarea aria-label={destructiveTarget.mode === 'kill' ? 'Emergency stop reason' : 'Revocation reason'} required value={destructiveReason} onChange={(event) => setDestructiveReason(event.target.value)} /></label>
            <div className="agent-command__modal-actions"><button onClick={() => setDestructiveTarget(null)}>Cancel</button><button className="danger" onClick={submitDestructiveAction} disabled={destructiveReason.trim().length < 3 || busy !== ''}>{destructiveTarget.mode === 'kill' ? 'Stop agent now' : 'Revoke identity now'}</button></div>
          </div>
        </Modal>
      )}
    </main>
  );
}

function Metric({ label, value, detail, tone = '' }) {
  return <article className={`agent-command__metric ${tone ? `agent-command__metric--${tone}` : ''}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}

function Status({ value }) {
  const normalized = String(value || 'unknown').replaceAll('_', ' ');
  return <span className={`agent-command__status agent-command__status--${statusTone(value)}`}><span aria-hidden="true" />{normalized}</span>;
}

function Boundary({ label, value }) {
  return <div><dt>{label}</dt><dd title={String(value)}>{value}</dd></div>;
}

function BoundaryChips({ label, values, empty }) {
  return <div className="agent-command__chips"><span>{label}</span><div>{values?.length ? values.map((value) => <code key={value}>{value}</code>) : <em>{empty}</em>}</div></div>;
}

function Modal({ title, onClose, children }) {
  return <div className="agent-command__scrim" onKeyDown={(event) => event.key === 'Escape' && onClose()} onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="agent-command__modal" role="dialog" aria-modal="true" aria-label={title}><div className="agent-command__modal-head"><h2>{title}</h2><button autoFocus aria-label={`Close ${title}`} onClick={onClose}>Close</button></div>{children}</section></div>;
}

function EmptyPanel({ title, detail }) {
  return <div className="agent-command__empty"><strong>{title}</strong><span>{detail}</span></div>;
}

function LoadingPanel({ label }) {
  return <div className="agent-command__empty agent-command__loading" role="status"><strong>{label}</strong><span>Reading workspace-scoped posture and approvals.</span></div>;
}

function replaceById(setter, next) {
  setter((current) => current.map((item) => item.id === next.id ? next : item));
}

function commaList(value) {
  return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
}

function validDecision(value) {
  return value.reason.trim().length >= 3 && EVIDENCE_HASH_PATTERN.test(value.evidenceHash.trim());
}

function statusTone(value) {
  if (['active', 'approved', 'allow', 'succeeded'].includes(value)) return 'safe';
  if (['pending', 'pending_review', 'review', 'queued', 'running'].includes(value)) return 'warning';
  if (['disabled', 'revoked', 'blocked', 'block', 'failed', 'cancelled', 'expired'].includes(value)) return 'danger';
  return 'neutral';
}

function identityName(identities, id) {
  return identities.find((item) => item.id === id || item.agentId === id)?.displayName || id;
}

function shortHash(value) {
  return value && value.length > 24 ? `${value.slice(0, 18)}…${value.slice(-6)}` : value || 'not supplied';
}

function formatTime(value) {
  if (!value) return 'not recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function pastTense(action) {
  return action === 'approve' ? 'approved' : action === 'block' ? 'blocked' : 'revoked';
}

async function copyCredential(value, addToast) {
  try {
    await navigator.clipboard.writeText(value);
    addToast?.('Credential copied. Move it directly into the agent secret manager.', 'success');
  } catch {
    addToast?.('Clipboard access was blocked. Select and copy the credential manually.', 'warning');
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function isRetryableControlError(error) {
  if (error instanceof ApiError) {
    return error.status === 429 || error.status >= 500;
  }
  return error instanceof TypeError;
}
