const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000';
let authToken = null;
let qaAuthToken = null;
let selectedWorkspaceId = typeof window !== 'undefined' ? window.localStorage.getItem('neuralops-workspace-id') : null;

export function setApiAuthToken(token) {
  authToken = token;
}

export function setQaAuthToken(token) {
  qaAuthToken = token;
}

export function setApiWorkspaceId(workspaceId) {
  selectedWorkspaceId = workspaceId || null;
  if (typeof window === 'undefined') return;
  if (selectedWorkspaceId) {
    window.localStorage.setItem('neuralops-workspace-id', selectedWorkspaceId);
  } else {
    window.localStorage.removeItem('neuralops-workspace-id');
  }
}

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...(qaAuthToken ? { 'x-neuralops-qa-token': qaAuthToken } : {}),
      ...(selectedWorkspaceId ? { 'x-neuralops-workspace-id': selectedWorkspaceId } : {}),
      ...(options.headers || {}),
    },
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

export function fetchSystemStatus() {
  return request('/api/system/status');
}

export function fetchActionCenter() {
  return request('/api/action-center');
}

export function fetchControlCenter() {
  return request('/api/control-center');
}

export function exportControlCenter() {
  return request('/api/control-center/export', { method: 'POST' });
}

export function fetchRiskExceptions() {
  return request('/api/risk-exceptions');
}

export function createRiskException(payload) {
  return request('/api/risk-exceptions', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function patchRiskException(exceptionId, patch) {
  return request(`/api/risk-exceptions/${exceptionId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function revokeRiskException(exceptionId) {
  return request(`/api/risk-exceptions/${exceptionId}/revoke`, { method: 'POST' });
}

export function fetchEstateSummary() {
  return request('/api/estate/summary');
}

export function fetchEstateGraph() {
  return request('/api/estate/graph');
}

export function fetchEstateSystem(systemId) {
  return request(`/api/estate/systems/${systemId}`);
}

export function patchEstateSystem(systemId, patch) {
  return request(`/api/estate/systems/${systemId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function rebuildEstateGraph() {
  return request('/api/estate/rebuild', { method: 'POST' });
}

export function fetchAiSlos() {
  return request('/api/slos');
}

export function createAiSlo(payload) {
  return request('/api/slos', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function patchAiSlo(sloId, patch) {
  return request(`/api/slos/${sloId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function evaluateAiSlos() {
  return request('/api/slos/evaluate', { method: 'POST' });
}

export function evaluateAiSlo(sloId) {
  return request(`/api/slos/${sloId}/evaluate`, { method: 'POST' });
}

export function runReleaseGate(payload = {}) {
  return request('/api/release-gate/run', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function fetchLatestReleaseGate() {
  return request('/api/release-gate/latest');
}

export function fetchReleaseGates() {
  return request('/api/release-gates');
}

export function createReleaseGate(payload) {
  return request('/api/release-gates', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function runSavedReleaseGate(gateId, payload = {}) {
  return request(`/api/release-gates/${gateId}/run`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function fetchEvidenceReport() {
  return request('/api/evidence');
}

export function fetchEvidenceExportPack() {
  return request('/api/evidence/export', { method: 'POST' });
}

export function runReleaseAutopilot(payload) {
  return request('/api/release-autopilot/run', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function fetchLatestReleaseAutopilot() {
  return request('/api/release-autopilot/latest');
}

export function fetchAutomations() {
  return request('/api/automations');
}

export function createAutomation(payload) {
  return request('/api/automations', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function patchAutomation(ruleId, patch) {
  return request(`/api/automations/${ruleId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function runAutomationTest(ruleId, payload = {}) {
  return request(`/api/automations/${ruleId}/run-test`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function fetchAutomationEvents() {
  return request('/api/automation-events');
}

export function fetchConnectorDeliveries() {
  return request('/api/connector-deliveries');
}

export function retryConnectorDelivery(deliveryId) {
  return request(`/api/connector-deliveries/${deliveryId}/retry`, { method: 'POST' });
}

export function processConnectorDeliveries(payload = {}) {
  return request('/api/connector-deliveries/process', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function postGithubPrComment(payload) {
  return request('/api/github/pr-comment', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function fetchConnectGuide() {
  return request('/api/connect/guide');
}

export function fetchOnboarding() {
  return request('/api/onboarding');
}

export function fetchOnboardingStatus() {
  return request('/api/onboarding/status');
}

export function sendOnboardingTestTrace() {
  return request('/api/onboarding/send-test-trace', { method: 'POST' });
}

export function runOnboardingProofDrill(type) {
  return request('/api/onboarding/run-proof-drill', {
    method: 'POST',
    body: JSON.stringify({ type }),
  });
}

export function fetchProductionReadiness() {
  return request('/api/production/readiness');
}

export function fetchReadinessScore() {
  return request('/api/readiness/score');
}

export function runReadinessCheck() {
  return request('/api/readiness/run', { method: 'POST' });
}

export function fetchConnectivity() {
  return request('/api/connectivity');
}

export function fetchConnectivityContract() {
  return request('/api/connectivity/contract');
}

export function fetchSyntheticCanaryLatest() {
  return request('/api/synthetic/latest');
}

export function runSyntheticCanary(payload = {}) {
  return request('/api/synthetic/run', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function bootstrapOnboarding() {
  return request('/api/onboarding/bootstrap', { method: 'POST' });
}

export function fetchAccessPolicy() {
  return request('/api/access/policy');
}

export function checkAccessPermission(payload) {
  return request('/api/access/check', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function fetchAccessAudit() {
  return request('/api/access/audit');
}

export function verifyConnectIngest(payload, apiKey) {
  return request('/api/connect/verify', {
    method: 'POST',
    headers: {
      'x-neuralops-key': apiKey,
    },
    body: JSON.stringify(payload),
  });
}

export function routeGatewayChatCompletion(payload, apiKey) {
  return request('/api/gateway/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'x-neuralops-key': apiKey,
    },
    body: JSON.stringify(payload),
  });
}

export function fetchGatewayRoutes() {
  return request('/api/gateway/routes');
}

export function fetchGatewayMetrics() {
  return request('/api/gateway/metrics');
}

export function fetchGatewayRequests() {
  return request('/api/gateway/requests');
}

export function fetchGatewayCostSuggestions() {
  return request('/api/gateway/cost-suggestions');
}

export function fetchGatewayRoutingPolicy() {
  return request('/api/gateway/routing-policy');
}

export function updateGatewayRoutingPolicy(payload) {
  return request('/api/gateway/routing-policy', {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export function fetchGatewayBudgets() {
  return request('/api/gateway/budgets');
}

export function createGatewayBudget(payload) {
  return request('/api/gateway/budgets', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function updateGatewayBudget(budgetId, patch) {
  return request(`/api/gateway/budgets/${budgetId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function clearGatewayCache() {
  return request('/api/gateway/cache/clear', { method: 'POST' });
}

export function fetchProviderCalibrations() {
  return request('/api/providers/calibrations');
}

export function fetchLatestProviderCalibration() {
  return request('/api/providers/calibrations/latest');
}

export function runProviderCalibration(payload) {
  return request('/api/providers/calibrate', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
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

export function updateCostBudget(budgetLimit) {
  return request('/api/costs/budget', {
    method: 'PATCH',
    body: JSON.stringify({ budgetLimit }),
  });
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

export function fetchProviderCatalog() {
  return request('/api/providers/catalog');
}

export function fetchProviderConnections() {
  return request('/api/providers/connections');
}

export function createProviderConnection(payload) {
  return request('/api/providers/connections', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function testProviderConnection(connectionId) {
  return request(`/api/providers/connections/${connectionId}/test`, { method: 'POST' });
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

export function runReplayGate(traceId, payload = {}) {
  return request(`/api/traces/${traceId}/replay-gate`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function runDatasetReplayGate(payload = {}) {
  return request('/api/replay-gate/dataset/run', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function fetchDetections() {
  return request('/api/detections');
}

export function analyzeLatestDetection(payload = { owner: 'AI Platform Oncall' }) {
  return request('/api/detections/analyze-latest', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function analyzeTraceDetection(traceId, payload = { owner: 'AI Platform Oncall' }) {
  return request(`/api/detections/analyze-trace/${traceId}`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function patchDetectionAction(caseId, payload) {
  return request(`/api/detections/${caseId}/action`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export function fetchSettings() {
  return request('/api/settings');
}

export function fetchWorkspace() {
  return request('/api/workspace');
}

export function fetchWorkspaceMembers() {
  return request('/api/workspace/members');
}

export function fetchWorkspaceInvites() {
  return request('/api/workspace/invites');
}

export function createWorkspaceInvite(payload) {
  return request('/api/workspace/invites', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function acceptWorkspaceInvite(token) {
  return request(`/api/workspace/invites/${encodeURIComponent(token)}/accept`, { method: 'POST' });
}

export function createWorkspaceMember(payload) {
  return request('/api/workspace/members', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function patchWorkspaceMember(memberId, patch) {
  return request(`/api/workspace/members/${memberId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function deleteWorkspaceMember(memberId) {
  return request(`/api/workspace/members/${memberId}`, { method: 'DELETE' });
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
