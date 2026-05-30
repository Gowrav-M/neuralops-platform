const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000';

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `Request failed with ${response.status}`);
  }

  return response.json();
}

export function fetchDashboard() {
  return request('/api/dashboard');
}

export function fetchTraces() {
  return request('/api/traces');
}

export function fetchTraceDetail(traceId) {
  return request(`/api/traces/${traceId}`);
}

export function fetchPrompts() {
  return request('/api/prompts');
}

export function deployPrompt(promptId) {
  return request(`/api/prompts/${promptId}/deploy`, { method: 'POST' });
}

export function fetchEvals() {
  return request('/api/evals');
}

export function runEvals() {
  return request('/api/evals/run', { method: 'POST' });
}

export function fetchRagQuality() {
  return request('/api/rag');
}

export function fetchCosts() {
  return request('/api/costs');
}

export function fetchPolicies() {
  return request('/api/policies');
}

export function fetchAgents() {
  return request('/api/agents');
}

export function fetchAgentDefinitions() {
  return request('/api/agent-runtime/definitions');
}

export function fetchAgentProviders() {
  return request('/api/agent-runtime/providers');
}

export function fetchAgentRuns() {
  return request('/api/agent-runtime/runs');
}

export function runAgent(payload) {
  return request('/api/agent-runtime/run', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function ingestSampleOtelTrace() {
  return request('/api/traces/otel/sample', { method: 'POST' });
}

export function replayTrace(traceId) {
  return request(`/api/traces/${traceId}/replay`, { method: 'POST' });
}

export function fetchSettings() {
  return request('/api/settings');
}

export function simulateTrace() {
  return request('/api/traces/simulate', { method: 'POST' });
}

export function patchIncident(incidentId, patch) {
  return request(`/api/incidents/${incidentId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function testPolicy(input, policyId) {
  return request('/api/policies/test', {
    method: 'POST',
    body: JSON.stringify({ input, policyId }),
  });
}

export function simulateCostAnomaly() {
  return request('/api/costs/simulate-anomaly', { method: 'POST' });
}

export { API_BASE_URL };
