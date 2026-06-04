import { useCallback, useEffect, useState } from 'react';
import {
  createAutomation,
  fetchAutomationEvents,
  fetchAutomations,
  fetchConnectorDeliveries,
  patchAutomation,
  processConnectorDeliveries,
  retryConnectorDelivery,
  runAutomationTest,
} from '../lib/api';

const triggers = [
  ['release_gate.blocked', 'Release gate blocked'],
  ['release_gate.review', 'Release gate needs review'],
  ['trace.blocked', 'Trace blocked'],
  ['trace.failed', 'Trace failed'],
  ['policy.violation', 'Policy violation'],
  ['cost.budget_risk', 'Cost budget risk'],
];

const actions = [
  ['create_incident', 'Create incident'],
  ['webhook_record', 'Record webhook notification'],
  ['audit_only', 'Audit only'],
];

export default function AutomationCenter({ addToast }) {
  const [rules, setRules] = useState([]);
  const [events, setEvents] = useState([]);
  const [deliveries, setDeliveries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: 'Block failed AI release',
    trigger: 'release_gate.blocked',
    action: 'create_incident',
    severity: 'Critical',
    owner: 'AI Platform Oncall',
    description: 'Open an incident when the release evidence gate blocks production.',
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextRules, nextEvents, nextDeliveries] = await Promise.all([fetchAutomations(), fetchAutomationEvents(), fetchConnectorDeliveries()]);
      setRules(nextRules);
      setEvents(nextEvents);
      setDeliveries(nextDeliveries);
    } catch {
      addToast('Automation backend is unavailable.', 'error');
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      load();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  const updateField = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const handleCreate = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      const rule = await createAutomation({ ...form, enabled: true });
      setRules((current) => [rule, ...current]);
      setForm((current) => ({ ...current, name: '', description: '' }));
      addToast(`Automation rule saved: ${rule.name}.`, 'success');
    } catch {
      addToast('Could not save automation rule.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (rule) => {
    try {
      const updated = await patchAutomation(rule.id, { enabled: !rule.enabled });
      setRules((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      addToast(`${updated.name} is ${updated.enabled ? 'enabled' : 'disabled'}.`, updated.enabled ? 'success' : 'warning');
    } catch {
      addToast('Could not update automation rule.', 'error');
    }
  };

  const handleTest = async (rule) => {
    try {
      const event = await runAutomationTest(rule.id, {
        subjectId: 'manual-test',
        subjectType: 'automation-test',
        decision: rule.trigger.includes('blocked') ? 'block' : 'review',
        summary: `Manual test for ${rule.name}.`,
      });
      await load();
      addToast(`Automation test recorded: ${event.status}.`, event.status === 'recorded' ? 'success' : 'warning');
    } catch {
      addToast('Automation test failed.', 'error');
    }
  };

  const handleRetryDelivery = async (deliveryId) => {
    try {
      const delivery = await retryConnectorDelivery(deliveryId);
      await load();
      addToast(`Delivery retry queued: attempt ${delivery.attempt}.`, 'success');
    } catch {
      addToast('Could not retry connector delivery.', 'error');
    }
  };

  const handleProcessDeliveries = async (sendExternal = false) => {
    try {
      const result = await processConnectorDeliveries({ limit: 10, sendExternal });
      await load();
      const message = sendExternal
        ? `Worker processed ${result.processed}: ${result.delivered} delivered, ${result.failed} failed.`
        : `Dry run found ${result.skipped} delivery attempt(s) ready for the worker.`;
      addToast(message, result.failed ? 'warning' : 'success');
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Connector worker could not run.', 'error');
    }
  };

  return (
    <div className="main-panel">
      <div className="page-header">
        <div>
          <h1 className="page-title">Automation Center</h1>
          <p className="page-subtitle">
            Turn AI release, trace, policy, and cost signals into persisted operational actions.
          </p>
        </div>
        <button className="btn-secondary" onClick={load} disabled={loading}>
          Refresh Automations
        </button>
      </div>

      <section className="automation-hero">
        <div>
          <span className="metric-label">Enterprise workflow</span>
          <h3>Detect. Decide. Act. Prove.</h3>
          <p>
            Rules run locally against NeuralOps evidence. They create incidents, audit records, or webhook notification records without sending secrets outside the backend.
          </p>
        </div>
        <div className="automation-stats">
          <div>
            <strong>{rules.length}</strong>
            <span>Rules</span>
          </div>
          <div>
            <strong>{events.length}</strong>
            <span>Runs</span>
          </div>
          <div>
            <strong>{deliveries.length}</strong>
            <span>Deliveries</span>
          </div>
          <div>
            <strong>{rules.filter((rule) => rule.enabled).length}</strong>
            <span>Enabled</span>
          </div>
        </div>
      </section>

      <section className="automation-grid">
        <form className="card-container automation-form" onSubmit={handleCreate}>
          <div className="dark-panel-title-row">
            <div>
              <span className="dark-panel-title">New Automation Rule</span>
              <p className="page-subtitle">Start with the actions enterprises ask for first: incidents, audit, and notification records.</p>
            </div>
          </div>
          <label>
            <span className="metric-label">Rule name</span>
            <input className="filter-search-input" value={form.name} onChange={(event) => updateField('name', event.target.value)} placeholder="e.g. Block unsafe production release" />
          </label>
          <div className="automation-form-row">
            <label>
              <span className="metric-label">Trigger</span>
              <select className="filter-select" value={form.trigger} onChange={(event) => updateField('trigger', event.target.value)}>
                {triggers.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
              </select>
            </label>
            <label>
              <span className="metric-label">Action</span>
              <select className="filter-select" value={form.action} onChange={(event) => updateField('action', event.target.value)}>
                {actions.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
              </select>
            </label>
          </div>
          <div className="automation-form-row">
            <label>
              <span className="metric-label">Severity</span>
              <select className="filter-select" value={form.severity} onChange={(event) => updateField('severity', event.target.value)}>
                {['Critical', 'Major', 'Minor', 'Low'].map((severity) => <option value={severity} key={severity}>{severity}</option>)}
              </select>
            </label>
            <label>
              <span className="metric-label">Owner</span>
              <input className="filter-search-input" value={form.owner} onChange={(event) => updateField('owner', event.target.value)} />
            </label>
          </div>
          <label>
            <span className="metric-label">Description</span>
            <textarea className="automation-textarea" value={form.description} onChange={(event) => updateField('description', event.target.value)} />
          </label>
          <button className="btn-primary" type="submit" disabled={saving || !form.name}>
            {saving ? 'Saving...' : 'Save Automation Rule'}
          </button>
        </form>

        <div className="card-container automation-list">
          <div className="dark-panel-title-row">
            <div>
              <span className="dark-panel-title">Active Rules</span>
              <p className="page-subtitle">Each rule is persisted and counted in the system truth contract.</p>
            </div>
          </div>
          {loading ? (
            <div className="state-container">Loading automation rules...</div>
          ) : rules.length ? rules.map((rule) => (
            <div className="automation-rule-row" key={rule.id}>
              <div>
                <strong>{rule.name}</strong>
                <span className="code-font">{rule.trigger} {'->'} {rule.action}</span>
                <small>{rule.runCount} run(s) | owner {rule.owner}</small>
              </div>
              <div className="automation-actions">
                <span className={`badge ${rule.enabled ? 'badge-success' : 'badge-warning'}`}>{rule.enabled ? 'enabled' : 'disabled'}</span>
                <button className="btn-secondary" type="button" onClick={() => handleTest(rule)} disabled={!rule.enabled}>Test</button>
                <button className="btn-secondary" type="button" onClick={() => handleToggle(rule)}>
                  {rule.enabled ? 'Disable' : 'Enable'}
                </button>
              </div>
            </div>
          )) : (
            <div className="state-container">No automation rules yet. Create one to make NeuralOps act on failures.</div>
          )}
        </div>
      </section>

      <section className="card-container">
        <div className="dark-panel-title-row">
          <div>
            <span className="dark-panel-title">Automation Event Log</span>
            <p className="page-subtitle">Proof that a rule handled a release, trace, policy, cost, or manual test signal.</p>
          </div>
        </div>
        <div className="table-container">
          <table className="dense-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Rule</th>
                <th>Subject</th>
                <th>Action</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {events.slice(0, 12).map((event) => (
                <tr key={event.id}>
                  <td>{event.createdAt.slice(11, 19)}</td>
                  <td>{event.ruleName}</td>
                  <td>{event.subjectType} / {event.subjectId}</td>
                  <td>{event.action}</td>
                  <td><span className={`badge ${event.status === 'recorded' ? 'badge-success' : 'badge-warning'}`}>{event.status}</span></td>
                </tr>
              ))}
              {!events.length && (
                <tr>
                  <td colSpan="5">No automation events recorded yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card-container">
        <div className="dark-panel-title-row">
          <div>
            <span className="dark-panel-title">Connector Delivery Attempts</span>
            <p className="page-subtitle">Signed Slack, Jira, and webhook attempts are persisted for a gated worker, retry, and audit review.</p>
          </div>
          <div className="button-cluster">
            <button className="btn-secondary" type="button" onClick={() => handleProcessDeliveries(false)}>
              Dry Run Worker
            </button>
            <button className="btn-primary" type="button" onClick={() => handleProcessDeliveries(true)}>
              Send Enabled Queue
            </button>
          </div>
        </div>
        <div className="table-container">
          <table className="dense-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Connector</th>
                <th>Subject</th>
                <th>Attempt</th>
                <th>Status</th>
                <th>Signature</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.slice(0, 10).map((delivery) => (
                <tr key={delivery.id}>
                  <td>{delivery.createdAt.slice(11, 19)}</td>
                  <td>{delivery.connectorName}</td>
                  <td>{delivery.subjectType} / {delivery.subjectId}</td>
                  <td>{delivery.attempt}</td>
                  <td><span className={`badge ${delivery.status === 'delivered' ? 'badge-success' : delivery.status === 'failed' ? 'badge-error' : 'badge-warning'}`}>{delivery.status}</span></td>
                  <td className="code-font">{delivery.signature.slice(0, 18)}...</td>
                  <td>
                    <button className="btn-secondary" type="button" onClick={() => handleRetryDelivery(delivery.id)}>
                      Retry
                    </button>
                  </td>
                </tr>
              ))}
              {!deliveries.length && (
                <tr>
                  <td colSpan="7">No connector deliveries yet. Add a webhook in Settings and run a webhook automation rule.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
