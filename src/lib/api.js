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

export function updatePromptTraffic(promptId, canaryPercent) {
  return request(`/api/prompts/${promptId}/traffic`, {
    method: 'POST',
    body: JSON.stringify({ canaryPercent }),
  });
}

export function rollbackPrompt(promptId) {
  return request(`/api/prompts/${promptId}/rollback`, { method: 'POST' });
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

export function testRagRetrieval(payload) {
  return request('/api/rag/test', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function fetchCosts() {
  return request('/api/costs');
}

export function fetchPolicies() {
  return request('/api/policies');
}

export function patchPolicy(policyId, patch) {
  return request(`/api/policies/${policyId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function fetchPolicyViolations() {
  return request('/api/policy-violations');
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

export function fetchAgentJobs() {
  return request('/api/agent-runtime/jobs');
}

export function fetchAgentJobSummary() {
  return request('/api/agent-runtime/jobs/summary');
}

export function submitAgentJob(payload) {
  return request('/api/agent-runtime/jobs', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function processAgentJob(jobId) {
  return request(`/api/agent-runtime/jobs/${jobId}/process`, { method: 'POST' });
}

export function processNextAgentJob() {
  return request('/api/agent-runtime/jobs/process-next', { method: 'POST' });
}

export function retryAgentJob(jobId) {
  return request(`/api/agent-runtime/jobs/${jobId}/retry`, { method: 'POST' });
}

export function cancelAgentJob(jobId) {
  return request(`/api/agent-runtime/jobs/${jobId}/cancel`, { method: 'POST' });
}

export function runAgent(payload) {
  return request('/api/agent-runtime/run', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function fetchLabExperiments() {
  return request('/api/labs/experiments');
}

export function runLabExperiment(payload) {
  return request('/api/labs/run', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function replayTrace(traceId) {
  return request(`/api/traces/${traceId}/replay`, { method: 'POST' });
}

export function fetchSettings() {
  return request('/api/settings');
}

export function createApiKey(payload) {
  return request('/api/settings/api-keys', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function createWebhook(payload) {
  return request('/api/settings/webhooks', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function updateRetention(retentionDays) {
  return request('/api/settings/retention', {
    method: 'PATCH',
    body: JSON.stringify({ retentionDays }),
  });
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

export { API_BASE_URL };
