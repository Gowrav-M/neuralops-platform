import { useEffect, useMemo, useState } from 'react';
import {
  clearGatewayCache,
  createGatewayBudget,
  fetchGatewayBudgets,
  fetchGatewayCostSuggestions,
  fetchGatewayMetrics,
  fetchGatewayRequests,
  fetchGatewayRoutingPolicy,
  fetchProviderCalibrations,
  updateGatewayBudget,
  updateGatewayRoutingPolicy,
  runProviderCalibration,
} from '../lib/api';

const statusBadge = {
  routed: 'badge-success',
  blocked: 'badge-error',
  budget_exceeded: 'badge-error',
  rate_limited: 'badge-warning',
  failed: 'badge-error',
  not_configured: 'badge-warning',
  passed: 'badge-success',
};

const decisionBadge = {
  allow: 'badge-success',
  review: 'badge-warning',
  block: 'badge-error',
};

const strategyCopy = {
  priority: 'Route by configured provider priority.',
  lowest_cost: 'Prefer the lowest known local price estimate.',
  lowest_latency: 'Prefer providers with better observed latency.',
  balanced: 'Blend cost, latency, health, success rate, and priority.',
};

const emptyMetrics = {
  totalRequests: 0,
  routedRequests: 0,
  failedRequests: 0,
  blockedRequests: 0,
  cacheHits: 0,
  estimatedSpendUsd: 0,
  actualSpendUsd: 0,
  providerBreakdown: [],
  latestRoutes: [],
};

export default function GatewayCenter({ addToast }) {
  const [metrics, setMetrics] = useState(emptyMetrics);
  const [requests, setRequests] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [policy, setPolicy] = useState(null);
  const [budgets, setBudgets] = useState([]);
  const [calibrations, setCalibrations] = useState([]);
  const [calibrationForm, setCalibrationForm] = useState({
    environment: 'staging',
    prompt: 'Summarize this production AI incident in one sentence with safe operational wording.',
    maxLatencyMs: 2500,
    maxEstimatedCostUsd: '',
  });
  const [budgetForm, setBudgetForm] = useState({
    environment: 'staging',
    limitUsd: 10,
    softLimitUsd: 8,
    period: 'monthly',
    hardLimitEnabled: true,
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [calibrating, setCalibrating] = useState(false);

  const load = async () => {
    setError('');
    try {
      const [nextMetrics, nextRequests, nextSuggestions, nextPolicy, nextBudgets, nextCalibrations] = await Promise.all([
        fetchGatewayMetrics(),
        fetchGatewayRequests(),
        fetchGatewayCostSuggestions(),
        fetchGatewayRoutingPolicy(),
        fetchGatewayBudgets(),
        fetchProviderCalibrations(),
      ]);
      setMetrics(nextMetrics);
      setRequests(nextRequests);
      setSuggestions(nextSuggestions);
      setPolicy(nextPolicy);
      setBudgets(nextBudgets);
      setCalibrations(nextCalibrations);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gateway backend unavailable');
    }
  };

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchGatewayMetrics(),
      fetchGatewayRequests(),
      fetchGatewayCostSuggestions(),
      fetchGatewayRoutingPolicy(),
      fetchGatewayBudgets(),
      fetchProviderCalibrations(),
    ])
      .then(([nextMetrics, nextRequests, nextSuggestions, nextPolicy, nextBudgets, nextCalibrations]) => {
        if (cancelled) return;
        setMetrics(nextMetrics);
        setRequests(nextRequests);
        setSuggestions(nextSuggestions);
        setPolicy(nextPolicy);
        setBudgets(nextBudgets);
        setCalibrations(nextCalibrations);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Gateway backend unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const gatewayReady = metrics.providerBreakdown.length > 0 || metrics.routedRequests > 0;
  const cacheRate = metrics.totalRequests > 0 ? ((metrics.cacheHits / metrics.totalRequests) * 100).toFixed(1) : '0.0';

  const latestBudget = useMemo(() => {
    return budgets.find((item) => item.environment === budgetForm.environment) || budgets[0] || null;
  }, [budgets, budgetForm.environment]);

  const latestCalibration = calibrations[0] || null;

  const updatePolicyField = (field, value) => {
    setPolicy((current) => ({ ...(current || {}), [field]: value }));
  };

  const handleSavePolicy = async () => {
    if (!policy) return;
    setBusy(true);
    try {
      const saved = await updateGatewayRoutingPolicy({
        strategy: policy.strategy,
        retryAttempts: Number(policy.retryAttempts),
        retryBackoffMs: parseBackoffs(policy.retryBackoffMs),
        cacheEnabled: Boolean(policy.cacheEnabled),
        cacheTtlSeconds: Number(policy.cacheTtlSeconds),
        rateLimitPerMinute: Number(policy.rateLimitPerMinute),
        maxEstimatedCostUsd: policy.maxEstimatedCostUsd === '' || policy.maxEstimatedCostUsd === null ? null : Number(policy.maxEstimatedCostUsd),
      });
      setPolicy(saved);
      addToast('Gateway routing policy saved.', 'success');
      await load();
    } catch (err) {
      addToast('Gateway policy was not saved.', 'error');
      setError(err instanceof Error ? err.message : 'Gateway policy was not saved');
    } finally {
      setBusy(false);
    }
  };

  const handleCreateBudget = async () => {
    setBusy(true);
    try {
      const saved = await createGatewayBudget({
        environment: budgetForm.environment,
        limitUsd: Number(budgetForm.limitUsd),
        softLimitUsd: budgetForm.softLimitUsd === '' ? null : Number(budgetForm.softLimitUsd),
        period: budgetForm.period,
        hardLimitEnabled: Boolean(budgetForm.hardLimitEnabled),
      });
      setBudgets((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      addToast(`Gateway budget saved for ${saved.environment}.`, 'success');
      await load();
    } catch (err) {
      addToast('Gateway budget was not saved.', 'error');
      setError(err instanceof Error ? err.message : 'Gateway budget was not saved');
    } finally {
      setBusy(false);
    }
  };

  const handlePatchBudget = async (budget, patch) => {
    setBusy(true);
    try {
      const saved = await updateGatewayBudget(budget.id, patch);
      setBudgets((current) => current.map((item) => (item.id === saved.id ? saved : item)));
      addToast(`Updated ${saved.environment} gateway budget.`, 'success');
    } catch (err) {
      addToast('Gateway budget update failed.', 'error');
      setError(err instanceof Error ? err.message : 'Gateway budget update failed');
    } finally {
      setBusy(false);
    }
  };

  const handleClearCache = async () => {
    setBusy(true);
    try {
      const result = await clearGatewayCache();
      addToast(`Cleared ${result.cleared} gateway cache entries.`, 'success');
      await load();
    } catch (err) {
      addToast('Gateway cache clear failed.', 'error');
      setError(err instanceof Error ? err.message : 'Gateway cache clear failed');
    } finally {
      setBusy(false);
    }
  };

  const handleRunCalibration = async () => {
    setCalibrating(true);
    setError('');
    try {
      const run = await runProviderCalibration({
        environment: calibrationForm.environment,
        prompt: calibrationForm.prompt,
        maxLatencyMs: Number(calibrationForm.maxLatencyMs),
        maxEstimatedCostUsd: calibrationForm.maxEstimatedCostUsd === '' ? null : Number(calibrationForm.maxEstimatedCostUsd),
      });
      setCalibrations((current) => [run, ...current.filter((item) => item.id !== run.id)]);
      addToast(`Provider calibration finished: ${run.decision}.`, run.decision === 'allow' ? 'success' : 'warning');
      await load();
    } catch (err) {
      addToast('Provider calibration failed.', 'error');
      setError(err instanceof Error ? err.message : 'Provider calibration failed');
    } finally {
      setCalibrating(false);
    }
  };

  return (
    <div className="main-panel">
      <div className="page-header">
        <div>
          <h1 className="page-title">Intelligent Gateway</h1>
          <p className="page-subtitle">
            Route production LLM calls by policy, cost, latency, health, budget, and cache evidence. No provider is shown as live unless traffic was actually routed.
          </p>
        </div>
        <div className="gate-row-actions">
          <button className="btn-secondary" onClick={handleClearCache} disabled={busy}>
            Clear Exact Cache
          </button>
          <button className="btn-primary" onClick={load} disabled={busy}>
            Refresh Gateway
          </button>
        </div>
      </div>

      {error && (
        <div className="state-container" style={{ alignItems: 'flex-start', textAlign: 'left' }}>
          <strong>Gateway data unavailable</strong>
          <span>{error}</span>
        </div>
      )}

      <div className="gateway-hero">
        <div>
          <span className={`badge ${gatewayReady ? 'badge-success' : 'badge-warning'}`}>
            {gatewayReady ? 'route evidence available' : 'waiting for routed traffic'}
          </span>
          <h3>App to Gateway to Providers to Evidence</h3>
          <p>
            NeuralOps accepts OpenAI-compatible chat calls, enforces pre/post policy, chooses the route, stores trace evidence, and records budget/cache decisions for operators.
          </p>
        </div>
        <div className="gateway-kpi-grid">
          <MetricTile label="Routed calls" value={metrics.routedRequests} detail={`${metrics.totalRequests} total gateway requests`} />
          <MetricTile label="Failures" value={metrics.failedRequests} detail={`${metrics.blockedRequests} blocked or limited`} tone={metrics.failedRequests ? 'warn' : 'ok'} />
          <MetricTile label="Cache hit rate" value={`${cacheRate}%`} detail={`${metrics.cacheHits} exact-match hits`} />
          <MetricTile label="Actual spend" value={currency(metrics.actualSpendUsd)} detail={`${currency(metrics.estimatedSpendUsd)} estimated`} />
        </div>
      </div>

      <div className="card-container">
        <div className="dark-panel-title-row">
          <div>
            <span className="card-title">Provider Calibration</span>
            <p className="page-subtitle" style={{ marginTop: '6px' }}>
              Run a measured test across configured providers before trusting cost-aware routing. NeuralOps records latency, cost estimate, policy findings, trace, and route evidence.
            </p>
          </div>
          <span className={`badge ${latestCalibration ? decisionBadge[latestCalibration.decision] : 'badge-warning'}`}>
            {latestCalibration ? latestCalibration.decision : 'not run'}
          </span>
        </div>

        <div className="gateway-form-grid">
          <label>
            <span className="metric-label">Environment</span>
            <select
              className="filter-select"
              value={calibrationForm.environment}
              onChange={(event) => setCalibrationForm((current) => ({ ...current, environment: event.target.value }))}
            >
              <option value="staging">staging</option>
              <option value="prod">prod</option>
              <option value="dev">dev</option>
            </select>
          </label>
          <label>
            <span className="metric-label">Max latency ms</span>
            <input
              className="filter-search-input"
              type="number"
              min="1"
              value={calibrationForm.maxLatencyMs}
              onChange={(event) => setCalibrationForm((current) => ({ ...current, maxLatencyMs: event.target.value }))}
            />
          </label>
          <label>
            <span className="metric-label">Max estimated cost</span>
            <input
              className="filter-search-input"
              type="number"
              min="0"
              step="0.0001"
              placeholder="optional"
              value={calibrationForm.maxEstimatedCostUsd}
              onChange={(event) => setCalibrationForm((current) => ({ ...current, maxEstimatedCostUsd: event.target.value }))}
            />
          </label>
        </div>
        <label className="field-stack" style={{ marginTop: '14px' }}>
          <span className="metric-label">Calibration prompt</span>
          <textarea
            className="filter-search-input"
            rows="3"
            value={calibrationForm.prompt}
            onChange={(event) => setCalibrationForm((current) => ({ ...current, prompt: event.target.value }))}
          />
        </label>
        <div className="gate-row-actions" style={{ marginTop: '14px' }}>
          <button className="btn-primary" onClick={handleRunCalibration} disabled={calibrating}>
            {calibrating ? 'Running Calibration...' : 'Run Provider Calibration'}
          </button>
          {latestCalibration && (
            <span className="page-subtitle">
              Recommended: {latestCalibration.recommendedProviderLabel || 'none'} | {latestCalibration.summary.passed || 0}/{latestCalibration.summary.configuredProviders || 0} passed
            </span>
          )}
        </div>

        {latestCalibration && (
          <div className="table-container" style={{ marginTop: '16px', padding: '0' }}>
            <table className="dense-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Status</th>
                  <th>Score</th>
                  <th>Latency</th>
                  <th>Cost</th>
                  <th>Findings</th>
                  <th>Trace</th>
                </tr>
              </thead>
              <tbody>
                {latestCalibration.results.length ? latestCalibration.results.map((result) => (
                  <tr key={`${latestCalibration.id}-${result.providerId}`}>
                    <td>
                      <strong>{result.providerLabel}</strong>
                      <div className="code-font">{result.model}</div>
                    </td>
                    <td>
                      <span className={`badge ${statusBadge[result.status] || decisionBadge[result.decision] || 'badge-warning'}`}>
                        {result.status} / {result.decision}
                      </span>
                    </td>
                    <td>{result.score}</td>
                    <td>{result.latencyMs}ms</td>
                    <td>{currency(result.actualCostUsd ?? result.estimatedCostUsd ?? 0)}</td>
                    <td>{result.findings.length ? result.findings.join(', ') : 'none'}</td>
                    <td className="code-font">{result.traceId || result.routeEventId || 'not traced'}</td>
                  </tr>
                )) : (
                  <tr>
                    <td colSpan="7" style={{ color: 'var(--text-secondary)' }}>
                      No configured provider matched this environment. Add a provider in Settings, then rerun calibration.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="gateway-grid">
        <div className="card-container">
          <div className="dark-panel-title-row">
            <div>
              <span className="card-title">Routing Policy</span>
              <p className="page-subtitle" style={{ marginTop: '6px' }}>
                {strategyCopy[policy?.strategy] || 'Loading routing policy from backend.'}
              </p>
            </div>
            <span className="badge badge-info">{policy?.id || 'default'}</span>
          </div>

          <div className="gateway-form-grid">
            <label>
              <span className="metric-label">Strategy</span>
              <select className="filter-select" value={policy?.strategy || 'priority'} onChange={(event) => updatePolicyField('strategy', event.target.value)}>
                <option value="priority">priority</option>
                <option value="lowest_cost">lowest_cost</option>
                <option value="lowest_latency">lowest_latency</option>
                <option value="balanced">balanced</option>
              </select>
            </label>
            <label>
              <span className="metric-label">Retries</span>
              <input className="filter-search-input" type="number" min="1" max="5" value={policy?.retryAttempts ?? 3} onChange={(event) => updatePolicyField('retryAttempts', event.target.value)} />
            </label>
            <label>
              <span className="metric-label">Backoff ms</span>
              <input className="filter-search-input" value={Array.isArray(policy?.retryBackoffMs) ? policy.retryBackoffMs.join(',') : '100,400,1600'} onChange={(event) => updatePolicyField('retryBackoffMs', event.target.value)} />
            </label>
            <label>
              <span className="metric-label">Rate/min</span>
              <input className="filter-search-input" type="number" min="1" value={policy?.rateLimitPerMinute ?? 60} onChange={(event) => updatePolicyField('rateLimitPerMinute', event.target.value)} />
            </label>
            <label>
              <span className="metric-label">Max estimated cost</span>
              <input className="filter-search-input" type="number" min="0" step="0.0001" value={policy?.maxEstimatedCostUsd ?? ''} onChange={(event) => updatePolicyField('maxEstimatedCostUsd', event.target.value)} placeholder="optional" />
            </label>
            <label>
              <span className="metric-label">Cache TTL</span>
              <input className="filter-search-input" type="number" min="60" value={policy?.cacheTtlSeconds ?? 1800} onChange={(event) => updatePolicyField('cacheTtlSeconds', event.target.value)} />
            </label>
            <label className="gate-checkbox">
              <input type="checkbox" checked={Boolean(policy?.cacheEnabled)} onChange={(event) => updatePolicyField('cacheEnabled', event.target.checked)} />
              <span>Enable exact-match cache</span>
            </label>
          </div>
          <button className="btn-primary" onClick={handleSavePolicy} disabled={busy || !policy}>
            Save Routing Policy
          </button>
        </div>

        <div className="dark-panel-container">
          <div className="dark-panel-title-row">
            <span className="dark-panel-title">Provider Health</span>
            <span className="badge badge-success">{metrics.providerBreakdown.length}</span>
          </div>
          <div className="dark-list">
            {metrics.providerBreakdown.length ? metrics.providerBreakdown.map((provider) => (
              <div className="dark-list-item" key={provider.id}>
                <div className="item-meta">
                  <span className="item-title">{provider.label}</span>
                  <span className="item-subtitle">{provider.requests} request(s), {provider.failures} failure(s), {provider.avgLatencyMs}ms avg</span>
                </div>
                <span className="code-font">{currency(provider.spendUsd)}</span>
              </div>
            )) : (
              <div className="dark-list-item">
                <div className="item-meta">
                  <span className="item-title">No provider route evidence</span>
                  <span className="item-subtitle">Create a provider in Settings and route a gateway call.</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="gateway-grid">
        <div className="card-container">
          <div className="dark-panel-title-row">
            <div>
              <span className="card-title">Budgets</span>
              <p className="page-subtitle" style={{ marginTop: '6px' }}>
                Hard limits block before provider spend. Soft limits create review evidence.
              </p>
            </div>
            <span className="badge badge-warning">{latestBudget ? `${currency(latestBudget.remainingUsd)} left` : 'not set'}</span>
          </div>

          <div className="gateway-form-grid">
            <label>
              <span className="metric-label">Environment</span>
              <select className="filter-select" value={budgetForm.environment} onChange={(event) => setBudgetForm((current) => ({ ...current, environment: event.target.value }))}>
                <option value="prod">prod</option>
                <option value="staging">staging</option>
                <option value="dev">dev</option>
                <option value="all">all</option>
              </select>
            </label>
            <label>
              <span className="metric-label">Limit USD</span>
              <input className="filter-search-input" type="number" min="0" step="0.01" value={budgetForm.limitUsd} onChange={(event) => setBudgetForm((current) => ({ ...current, limitUsd: event.target.value }))} />
            </label>
            <label>
              <span className="metric-label">Soft limit USD</span>
              <input className="filter-search-input" type="number" min="0" step="0.01" value={budgetForm.softLimitUsd} onChange={(event) => setBudgetForm((current) => ({ ...current, softLimitUsd: event.target.value }))} />
            </label>
            <label>
              <span className="metric-label">Period</span>
              <select className="filter-select" value={budgetForm.period} onChange={(event) => setBudgetForm((current) => ({ ...current, period: event.target.value }))}>
                <option value="daily">daily</option>
                <option value="weekly">weekly</option>
                <option value="monthly">monthly</option>
              </select>
            </label>
            <label className="gate-checkbox">
              <input type="checkbox" checked={budgetForm.hardLimitEnabled} onChange={(event) => setBudgetForm((current) => ({ ...current, hardLimitEnabled: event.target.checked }))} />
              <span>Block at hard limit</span>
            </label>
          </div>
          <button className="btn-primary" onClick={handleCreateBudget} disabled={busy}>
            Save Budget
          </button>

          <div className="gateway-budget-list">
            {budgets.map((budget) => (
              <div className="gateway-budget-row" key={budget.id}>
                <div>
                  <strong>{budget.environment}</strong>
                  <span className="code-font">{currency(budget.spentUsd)} spent / {currency(budget.limitUsd)} limit | {budget.period}</span>
                </div>
                <div className="gate-row-actions">
                  <span className={`badge ${budget.remainingUsd <= 0 ? 'badge-error' : budget.softLimitUsd && budget.spentUsd >= budget.softLimitUsd ? 'badge-warning' : 'badge-success'}`}>
                    {currency(budget.remainingUsd)} left
                  </span>
                  <button className="btn-secondary" disabled={busy} onClick={() => handlePatchBudget(budget, { hardLimitEnabled: !budget.hardLimitEnabled })}>
                    {budget.hardLimitEnabled ? 'Disable Hard Limit' : 'Enable Hard Limit'}
                  </button>
                </div>
              </div>
            ))}
            {budgets.length === 0 && (
              <div className="state-container" style={{ padding: '18px' }}>
                <span>No gateway budgets are configured yet.</span>
              </div>
            )}
          </div>
        </div>

        <div className="card-container">
          <span className="card-title">Cost Suggestions</span>
          <div className="gateway-suggestion-list">
            {suggestions.length ? suggestions.map((suggestion) => (
              <div className="gateway-suggestion" key={suggestion.id}>
                <span className={`badge ${suggestion.severity === 'high' ? 'badge-error' : suggestion.severity === 'review' ? 'badge-warning' : 'badge-info'}`}>
                  {suggestion.severity}
                </span>
                <strong>{suggestion.title}</strong>
                <p>{suggestion.detail}</p>
                {suggestion.estimatedSavingsUsd !== null && suggestion.estimatedSavingsUsd !== undefined && (
                  <span className="code-font">estimated from evidence: {currency(suggestion.estimatedSavingsUsd)}</span>
                )}
              </div>
            )) : (
              <div className="state-container" style={{ padding: '18px' }}>
                <span>No cost suggestions yet. Suggestions are generated only from provider and route evidence.</span>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="table-container" style={{ padding: '20px' }}>
        <div className="dark-panel-title-row">
          <span style={{ fontSize: '15px', fontWeight: 700 }}>Latest Routing Decisions</span>
          <span className="badge badge-info">{requests.length}</span>
        </div>
        <table className="dense-table" style={{ marginTop: '12px' }}>
          <thead>
            <tr>
              <th>Status</th>
              <th>Environment</th>
              <th>Provider</th>
              <th>Strategy</th>
              <th>Cache</th>
              <th>Budget</th>
              <th>Cost</th>
              <th>Trace</th>
            </tr>
          </thead>
          <tbody>
            {requests.slice(0, 12).map((request) => (
              <tr key={request.id}>
                <td><span className={`badge ${statusBadge[request.status] || 'badge-warning'}`}>{request.status}</span></td>
                <td>{request.environment}</td>
                <td>{request.selectedProvider?.label || 'none'}</td>
                <td className="code-font">{request.routingStrategy} / {request.selectedReason}</td>
                <td>{request.cacheStatus}</td>
                <td>{request.budgetDecision}</td>
                <td>{currency(request.actualCostUsd ?? request.estimatedCostUsd ?? 0)}</td>
                <td className="code-font">{request.traceId || 'not traced'}</td>
              </tr>
            ))}
            {requests.length === 0 && (
              <tr>
                <td colSpan="8" style={{ color: 'var(--text-secondary)' }}>
                  No gateway request logs yet. Route a real call from Connect or the SDK.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MetricTile({ label, value, detail, tone = 'normal' }) {
  return (
    <div className={`gateway-metric-tile ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function currency(value) {
  const numeric = Number(value || 0);
  if (numeric < 0.01) return `$${numeric.toFixed(6)}`;
  return `$${numeric.toFixed(2)}`;
}

function parseBackoffs(value) {
  if (Array.isArray(value)) return value.map((item) => Number(item)).filter((item) => Number.isFinite(item) && item >= 0);
  return String(value || '')
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item >= 0);
}
