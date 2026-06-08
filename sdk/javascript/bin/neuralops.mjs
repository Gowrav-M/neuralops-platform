#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

function valueOf(args, flag, fallback = undefined) {
  const index = args.indexOf(flag);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

function has(args, flag) {
  return args.includes(flag);
}

function usage(stdout = console.log) {
  stdout(`NeuralOps CLI

Commands:
  neuralops doctor [options]
  neuralops send-test-trace [options]
  neuralops release-gate run [options]
  neuralops gate run [options]
  neuralops production ready [options]
  neuralops replay-gate run --trace <id> [options]
  neuralops replay-gate dataset [--trace <id,id>] [options]
  neuralops policy validate [options]
  neuralops policy test --input <text> [options]
  neuralops gateway doctor [options]
  neuralops gateway send-test [options]
  neuralops gateway routes [options]

Options:
  --base-url <url>             NeuralOps API URL. Defaults to NEURALOPS_API_URL or http://localhost:8000
  --api-key <key>              NeuralOps API key. Defaults to NEURALOPS_API_KEY
  --auth-token <jwt>           Supabase/Auth bearer token. Defaults to NEURALOPS_AUTH_TOKEN
  --qa-token <token>           Deployment QA token. Defaults to NEURALOPS_QA_AUTH_TOKEN
  --workspace-id <id>          Selected workspace id for authenticated checks.
  --environment <name>         Environment for test traces. Default: staging
  --check-gateway              Doctor also checks the OpenAI-compatible Policy Gateway
  --no-send-test-trace         Doctor skips writing a connectivity trace
  --gate-id <id>               Run a saved release gate definition.
  --target <name>              Target environment for ad hoc gates. Default: production
  --max-latency-ms <number>    Ad hoc latency threshold. Default: 2500
  --max-error-rate <number>    Ad hoc error threshold. Default: 0.05
  --min-eval-pass-rate <num>   Ad hoc eval threshold. Default: 0.85
  --require-live-provider      Require a configured live provider.
  --require-auth <bool>        Require auth in gate checks. Default: true
  --fail-on warn|fail|review|block
                               Doctor exits non-zero on warn/fail. Release gate exits on review/block.
  --policy-file <path>         Policy-as-code YAML file. Default: .neuralops/policies.yaml
  --trace <id>                 Trace id for replay-gate. Use comma-separated ids for replay-gate dataset.
  --trace-environment <scope>  Dataset replay trace scope: prod, staging, dev, or all. Default: all
  --limit <number>             Dataset replay trace limit when --trace is omitted. Default: 25
  --input <text>               Input text for policy test.
  --json                       Print raw JSON.
`);
}

function boolValue(args, flag, fallback) {
  if (!args.includes(flag)) return fallback;
  const value = valueOf(args, flag, "true");
  return !["0", "false", "no"].includes(String(value).toLowerCase());
}

function failThreshold(decision, failOn) {
  if (decision === "block") return true;
  return failOn === "review" && decision === "review";
}

function doctorShouldFail(summary, failOn) {
  if (failOn === "never") return false;
  if (summary.status === "fail") return true;
  return failOn === "warn" && summary.status === "warn";
}

function normalizeBaseUrl(args, env) {
  return (valueOf(args, "--base-url") || env.NEURALOPS_API_URL || "http://localhost:8000").replace(/\/$/, "");
}

function readApiKey(args, env) {
  return valueOf(args, "--api-key") || env.NEURALOPS_API_KEY || "";
}

async function parseResponse(response) {
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { detail: text };
  }
  return { ok: response.ok, status: response.status, body };
}

async function requestJson(fetchImpl, url, { method = "GET", payload, apiKey } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["x-neuralops-key"] = apiKey;
  const response = await fetchImpl(url, {
    method,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return parseResponse(response);
}

function requestHeaders({ apiKey, authToken, qaToken, workspaceId } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["x-neuralops-key"] = apiKey;
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  if (qaToken) headers["x-neuralops-qa-token"] = qaToken;
  if (workspaceId) headers["x-neuralops-workspace-id"] = workspaceId;
  return headers;
}

async function requestJsonWithHeaders(fetchImpl, url, { method = "GET", payload, apiKey, authToken, qaToken, workspaceId } = {}) {
  const response = await fetchImpl(url, {
    method,
    headers: requestHeaders({ apiKey, authToken, qaToken, workspaceId }),
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return parseResponse(response);
}

async function postJson(fetchImpl, url, payload, apiKey) {
  const result = await requestJson(fetchImpl, url, { method: "POST", payload, apiKey });
  if (!result.ok) {
    throw new Error(errorMessage(result));
  }
  return result.body;
}

function readAuthToken(args, env) {
  return valueOf(args, "--auth-token") || env.NEURALOPS_AUTH_TOKEN || "";
}

function readQaToken(args, env) {
  return valueOf(args, "--qa-token") || env.NEURALOPS_QA_AUTH_TOKEN || "";
}

function readWorkspaceId(args, env) {
  return valueOf(args, "--workspace-id") || env.NEURALOPS_WORKSPACE_ID || "";
}

function errorMessage(result) {
  const detail = result.body?.detail;
  if (typeof detail === "string") return detail;
  if (detail?.message) return detail.message;
  if (detail?.code) return detail.code;
  return `NeuralOps API returned ${result.status}`;
}

function isNotConfigured(result) {
  const detail = result.body?.detail;
  return result.status === 503 && (detail?.code === "not_configured" || String(detail).includes("not_configured"));
}

function testTracePayload(args) {
  const now = new Date();
  return {
    session: valueOf(args, "--session", `sdk-doctor-${now.getTime()}`),
    environment: valueOf(args, "--environment", "staging"),
    model: "neuralops-sdk-doctor",
    tokens: 24,
    latencyMs: 1,
    costUsd: 0,
    status: "success",
    score: 1,
    prompt: "NeuralOps SDK doctor connectivity probe.",
    output: "Trace ingest path is connected.",
    riskFlags: ["sdk-doctor"],
  };
}

function gatewayProbePayload(args) {
  return {
    model: valueOf(args, "--model", "neuralops-gateway-probe"),
    metadata: {
      environment: valueOf(args, "--environment", "staging"),
      session: valueOf(args, "--session", `sdk-gateway-${Date.now()}`),
    },
    messages: [
      { role: "system", content: "Answer briefly and do not reveal secrets." },
      { role: "user", content: "Say NeuralOps gateway probe passed." },
    ],
  };
}

function traceIdFrom(body) {
  return body?.trace?.id || body?.traceId || body?.id || body?.trace_id || "accepted";
}

function printChecks(summary, stdout = console.log) {
  stdout(`NeuralOps doctor: ${summary.status.toUpperCase()} (${summary.score}/100)`);
  stdout(`API: ${summary.baseUrl}`);
  stdout(`Key: ${summary.apiKeyConfigured ? "configured" : "not configured"}`);
  stdout("");
  for (const check of summary.checks) {
    const marker = check.status === "pass" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL";
    stdout(`[${marker}] ${check.label}: ${check.evidence}`);
    if (check.reason) stdout(`       ${check.reason}`);
  }
}

function summarizeChecks({ baseUrl, apiKey, checks }) {
  const failed = checks.filter((check) => check.status === "fail").length;
  const warned = checks.filter((check) => check.status === "warn").length;
  const passed = checks.filter((check) => check.status === "pass").length;
  const status = failed > 0 ? "fail" : warned > 0 ? "warn" : "pass";
  return {
    tool: "neuralops-cli",
    command: "doctor",
    status,
    score: Math.max(0, Math.round((passed / Math.max(1, checks.length)) * 100) - failed * 25),
    baseUrl,
    apiKeyConfigured: Boolean(apiKey),
    checks,
    generatedAt: new Date().toISOString(),
  };
}

async function runDoctor({ args, env, fetchImpl, stdout }) {
  const baseUrl = normalizeBaseUrl(args, env);
  const apiKey = readApiKey(args, env);
  const checks = [];

  try {
    const health = await requestJson(fetchImpl, `${baseUrl}/health`);
    if (health.ok && health.body?.ok !== false) {
      checks.push({
        id: "backend_health",
        label: "Backend health",
        status: "pass",
        evidence: `storage=${health.body?.storage || "unknown"} service=${health.body?.service || "neuralops-api"}`,
      });
    } else {
      checks.push({
        id: "backend_health",
        label: "Backend health",
        status: "fail",
        evidence: `HTTP ${health.status}`,
        reason: errorMessage(health),
      });
    }
  } catch (error) {
    checks.push({
      id: "backend_health",
      label: "Backend health",
      status: "fail",
      evidence: "could not reach backend",
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  if (!apiKey) {
    checks.push({
      id: "api_key",
      label: "API key",
      status: "warn",
      evidence: "NEURALOPS_API_KEY is not set; trace and gateway checks skipped",
    });
  } else if (!has(args, "--no-send-test-trace")) {
    try {
      const trace = await requestJson(fetchImpl, `${baseUrl}/api/traces/ingest`, {
        method: "POST",
        payload: testTracePayload(args),
        apiKey,
      });
      if (trace.ok) {
        checks.push({
          id: "trace_ingest",
          label: "Trace ingest",
          status: "pass",
          evidence: `stored trace ${traceIdFrom(trace.body)}`,
        });
      } else {
        checks.push({
          id: "trace_ingest",
          label: "Trace ingest",
          status: "fail",
          evidence: `HTTP ${trace.status}`,
          reason: errorMessage(trace),
        });
      }
    } catch (error) {
      checks.push({
        id: "trace_ingest",
        label: "Trace ingest",
        status: "fail",
        evidence: "trace write failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (has(args, "--check-gateway")) {
    if (!apiKey) {
      checks.push({
        id: "gateway",
        label: "Policy Gateway",
        status: "warn",
        evidence: "skipped because no API key is configured",
      });
    } else {
      try {
        const gateway = await requestJson(fetchImpl, `${baseUrl}/api/gateway/openai/v1/chat/completions`, {
          method: "POST",
          payload: gatewayProbePayload(args),
          apiKey,
        });
        if (gateway.ok) {
          checks.push({
            id: "gateway",
            label: "Policy Gateway",
            status: "pass",
            evidence: `provider path accepted${gateway.body?.neuralops?.traceId ? ` trace=${gateway.body.neuralops.traceId}` : ""}`,
          });
        } else if (isNotConfigured(gateway)) {
          checks.push({
            id: "gateway",
            label: "Policy Gateway",
            status: "warn",
            evidence: "live provider is not configured; gateway correctly refused fake output",
          });
        } else {
          checks.push({
            id: "gateway",
            label: "Policy Gateway",
            status: "fail",
            evidence: `HTTP ${gateway.status}`,
            reason: errorMessage(gateway),
          });
        }
      } catch (error) {
        checks.push({
          id: "gateway",
          label: "Policy Gateway",
          status: "fail",
          evidence: "gateway probe failed",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const summary = summarizeChecks({ baseUrl, apiKey, checks });
  if (has(args, "--json")) {
    stdout(JSON.stringify(summary, null, 2));
  } else {
    printChecks(summary, stdout);
  }
  return doctorShouldFail(summary, valueOf(args, "--fail-on", "fail")) ? 1 : 0;
}

async function runSendTestTrace({ args, env, fetchImpl, stdout }) {
  const baseUrl = normalizeBaseUrl(args, env);
  const apiKey = readApiKey(args, env);
  if (!apiKey) {
    throw new Error("NEURALOPS_API_KEY or --api-key is required for send-test-trace");
  }
  const body = await postJson(fetchImpl, `${baseUrl}/api/traces/ingest`, testTracePayload(args), apiKey);
  const result = {
    status: "pass",
    traceId: traceIdFrom(body),
    baseUrl,
    environment: valueOf(args, "--environment", "staging"),
  };
  if (has(args, "--json")) {
    stdout(JSON.stringify(result, null, 2));
  } else {
    stdout(`NeuralOps trace stored: ${result.traceId}`);
    stdout(`API: ${result.baseUrl}`);
    stdout(`Environment: ${result.environment}`);
  }
  return 0;
}

function printHuman(result, stdout = console.log) {
  stdout(`NeuralOps release gate: ${result.decision.toUpperCase()} (${result.score}/100)`);
  stdout(`Target: ${result.target}`);
  if (result.gateId) {
    stdout(`Gate: ${result.gateName} (${result.gateId})`);
  }
  stdout("");
  for (const check of result.checks || []) {
    const marker = check.status === "pass" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL";
    stdout(`[${marker}] ${check.label}: ${check.evidence}`);
    if (check.status !== "pass" && process.env.GITHUB_ACTIONS) {
      const level = check.status === "fail" ? "error" : "warning";
      stdout(`::${level} title=${check.label}::${check.reason} ${check.evidence}`);
    }
  }
  if (result.recommendations?.length) {
    stdout("");
    stdout("Recommendations:");
    for (const recommendation of result.recommendations) {
      stdout(`- ${recommendation}`);
    }
  }
}

function printProductionReadiness(result, stdout = console.log) {
  stdout(`NeuralOps production readiness: ${result.decision.toUpperCase()} (${result.score}/100)`);
  stdout(`Workspace: ${result.workspaceId}`);
  stdout("");
  for (const check of result.checks || []) {
    const marker = check.state === "pass" ? "PASS" : check.state === "review" ? "REVIEW" : "BLOCK";
    stdout(`[${marker}] ${check.label}: ${check.detail}`);
    if (check.state === "block" && process.env.GITHUB_ACTIONS) {
      stdout(`::error title=${check.label}::${check.detail}`);
    } else if (check.state === "review" && process.env.GITHUB_ACTIONS) {
      stdout(`::warning title=${check.label}::${check.detail}`);
    }
  }
  if (result.blockers?.length) {
    stdout("");
    stdout("Blockers:");
    for (const blocker of result.blockers) {
      stdout(`- ${blocker}`);
    }
  }
}

async function runGate({ args, env, fetchImpl, stdout }) {
  const baseUrl = normalizeBaseUrl(args, env);
  const gateId = valueOf(args, "--gate-id");
  const failOn = valueOf(args, "--fail-on", "block");
  if (!["review", "block"].includes(failOn)) {
    throw new Error("--fail-on must be review or block for release-gate");
  }
  const payload = gateId
    ? {
        gateId,
        target: valueOf(args, "--target", undefined),
        failOn,
      }
    : {
        target: valueOf(args, "--target", "production"),
        maxLatencyMs: Number(valueOf(args, "--max-latency-ms", "2500")),
        maxErrorRate: Number(valueOf(args, "--max-error-rate", "0.05")),
        minEvalPassRate: Number(valueOf(args, "--min-eval-pass-rate", "0.85")),
        requireLiveProvider: has(args, "--require-live-provider"),
        requireAuth: boolValue(args, "--require-auth", true),
      };
  const endpoint = gateId ? `/api/release-gates/${gateId}/run` : "/api/release-gate/run";
  const result = await postJson(fetchImpl, `${baseUrl}${endpoint}`, payload);
  if (has(args, "--json")) {
    stdout(JSON.stringify(result, null, 2));
  } else {
    printHuman(result, stdout);
  }
  return failThreshold(result.decision, failOn) ? 1 : 0;
}

async function runProductionReady({ args, env, fetchImpl, stdout }) {
  const baseUrl = normalizeBaseUrl(args, env);
  const failOn = valueOf(args, "--fail-on", "block");
  if (!["review", "block"].includes(failOn)) {
    throw new Error("--fail-on must be review or block for production ready");
  }
  const result = await requestJsonWithHeaders(fetchImpl, `${baseUrl}/api/production/readiness`, {
    authToken: readAuthToken(args, env),
    qaToken: readQaToken(args, env),
    workspaceId: readWorkspaceId(args, env),
  });
  if (!result.ok) {
    throw new Error(errorMessage(result));
  }
  if (has(args, "--json")) {
    stdout(JSON.stringify(result.body, null, 2));
  } else {
    printProductionReadiness(result.body, stdout);
  }
  return failThreshold(result.body.decision, failOn) ? 1 : 0;
}

function readPolicy(args) {
  const policyFile = valueOf(args, "--policy-file", ".neuralops/policies.yaml");
  const text = readFileSync(policyFile, "utf8");
  return validatePolicy(parsePolicyYaml(text), policyFile);
}

function parsePolicyYaml(text) {
  const policy = {};
  let listKey = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("- ") && listKey) {
      policy[listKey].push(coerceScalar(line.slice(2).trim()));
      continue;
    }
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match) {
      throw new Error(`Invalid policy line: ${rawLine}`);
    }
    const key = match[1];
    const value = match[2];
    if (value === "") {
      policy[key] = [];
      listKey = key;
    } else {
      policy[key] = coerceScalar(value);
      listKey = null;
    }
  }
  return policy;
}

function coerceScalar(value) {
  const unquoted = value.replace(/^["']|["']$/g, "");
  if (/^(true|false)$/i.test(unquoted)) return unquoted.toLowerCase() === "true";
  if (/^-?\d+(\.\d+)?$/.test(unquoted)) return Number(unquoted);
  return unquoted;
}

function validatePolicy(policy, policyFile = "policy") {
  const errors = [];
  if (policy.maxLatencyMs !== undefined && (!Number.isFinite(Number(policy.maxLatencyMs)) || Number(policy.maxLatencyMs) < 1)) {
    errors.push("maxLatencyMs must be a positive number");
  }
  if (policy.maxCostUsd !== undefined && (!Number.isFinite(Number(policy.maxCostUsd)) || Number(policy.maxCostUsd) < 0)) {
    errors.push("maxCostUsd must be zero or positive");
  }
  if (policy.minScore !== undefined && (Number(policy.minScore) < 0 || Number(policy.minScore) > 1)) {
    errors.push("minScore must be between 0 and 1");
  }
  if (policy.providerMode !== undefined && !["local", "auto", "live"].includes(String(policy.providerMode))) {
    errors.push("providerMode must be local, auto, or live");
  }
  if (policy.blockedPhrases !== undefined && !Array.isArray(policy.blockedPhrases)) {
    errors.push("blockedPhrases must be a list");
  }
  if (errors.length) {
    const error = new Error(`Invalid policy ${policyFile}: ${errors.join("; ")}`);
    error.validationErrors = errors;
    throw error;
  }
  return {
    maxLatencyMs: Number(policy.maxLatencyMs ?? 2500),
    maxCostUsd: Number(policy.maxCostUsd ?? 1),
    minScore: Number(policy.minScore ?? 0.85),
    providerMode: String(policy.providerMode ?? "local"),
    blockedPhrases: policy.blockedPhrases || [],
    requireLiveProvider: Boolean(policy.requireLiveProvider ?? false),
    policyFile,
  };
}

function evaluatePolicyInput(policy, input) {
  const text = String(input || "").toLowerCase();
  const matched = [];
  for (const phrase of policy.blockedPhrases || []) {
    if (text.includes(String(phrase).toLowerCase())) matched.push(String(phrase));
  }
  const builtIn = ["ignore previous", "ignore standard", "api key", "password", "secret", "token", "webhook"];
  for (const phrase of builtIn) {
    if (text.includes(phrase) && !matched.includes(phrase)) matched.push(phrase);
  }
  const decision = matched.some((phrase) => ["ignore previous", "api key", "password", "secret", "token", "webhook"].includes(phrase.toLowerCase()))
    ? "block"
    : matched.length
      ? "review"
      : "allow";
  return { decision, matchedPhrases: matched, policyFile: policy.policyFile };
}

async function runPolicy({ args, stdout }) {
  const subcommand = args[1];
  const policy = readPolicy(args);
  if (subcommand === "validate") {
    const result = { valid: true, policy };
    stdout(has(args, "--json") ? JSON.stringify(result, null, 2) : `Policy valid: ${policy.policyFile}`);
    return 0;
  }
  if (subcommand === "test") {
    const input = valueOf(args, "--input", "");
    if (!input) throw new Error("--input is required for policy test");
    const result = evaluatePolicyInput(policy, input);
    stdout(has(args, "--json") ? JSON.stringify(result, null, 2) : `Policy decision: ${result.decision.toUpperCase()}`);
    return result.decision === "block" ? 1 : 0;
  }
  throw new Error("policy command must be validate or test");
}

async function runReplayGate({ args, env, fetchImpl, stdout }) {
  const traceId = valueOf(args, "--trace");
  if (!traceId) throw new Error("--trace is required for replay-gate run");
  const baseUrl = normalizeBaseUrl(args, env);
  const failOn = valueOf(args, "--fail-on", "block");
  if (!["review", "block"].includes(failOn)) {
    throw new Error("--fail-on must be review or block for replay-gate");
  }
  let policy = {};
  try {
    policy = readPolicy(args);
  } catch (error) {
    if (has(args, "--policy-file")) throw error;
  }
  const payload = {
    target: valueOf(args, "--target", "production"),
    providerMode: valueOf(args, "--provider-mode", policy.providerMode || "local"),
    maxLatencyMs: Number(valueOf(args, "--max-latency-ms", policy.maxLatencyMs || "2500")),
    maxCostUsd: Number(valueOf(args, "--max-cost-usd", policy.maxCostUsd || "1")),
    minScore: Number(valueOf(args, "--min-score", policy.minScore || "0.85")),
    blockedPhrases: policy.blockedPhrases || [],
    requireLiveProvider: has(args, "--require-live-provider") || Boolean(policy.requireLiveProvider),
  };
  const result = await postJson(fetchImpl, `${baseUrl}/api/traces/${encodeURIComponent(traceId)}/replay-gate`, payload);
  if (has(args, "--json")) {
    stdout(JSON.stringify(result, null, 2));
  } else {
    printHuman(result, stdout);
  }
  return failThreshold(result.decision, failOn) ? 1 : 0;
}

function replayPolicyPayload(args) {
  let policy = {};
  try {
    policy = readPolicy(args);
  } catch (error) {
    if (has(args, "--policy-file")) throw error;
  }
  return {
    target: valueOf(args, "--target", "production"),
    providerMode: valueOf(args, "--provider-mode", policy.providerMode || "local"),
    maxLatencyMs: Number(valueOf(args, "--max-latency-ms", policy.maxLatencyMs || "2500")),
    maxCostUsd: Number(valueOf(args, "--max-cost-usd", policy.maxCostUsd || "1")),
    minScore: Number(valueOf(args, "--min-score", policy.minScore || "0.85")),
    blockedPhrases: policy.blockedPhrases || [],
    requireLiveProvider: has(args, "--require-live-provider") || Boolean(policy.requireLiveProvider),
  };
}

function traceIdsFromArgs(args) {
  const traceValue = valueOf(args, "--trace", "");
  return String(traceValue)
    .split(",")
    .map((traceId) => traceId.trim())
    .filter(Boolean);
}

async function runDatasetReplayGate({ args, env, fetchImpl, stdout }) {
  const baseUrl = normalizeBaseUrl(args, env);
  const failOn = valueOf(args, "--fail-on", "block");
  if (!["review", "block"].includes(failOn)) {
    throw new Error("--fail-on must be review or block for replay-gate dataset");
  }
  const traceEnvironment = valueOf(args, "--trace-environment", valueOf(args, "--environment", "all"));
  if (!["prod", "staging", "dev", "all"].includes(traceEnvironment)) {
    throw new Error("--trace-environment must be prod, staging, dev, or all");
  }
  const payload = {
    ...replayPolicyPayload(args),
    traceIds: traceIdsFromArgs(args),
    traceEnvironment,
    limit: Number(valueOf(args, "--limit", "25")),
  };
  const result = await postJson(fetchImpl, `${baseUrl}/api/replay-gate/dataset/run`, payload);
  if (has(args, "--json")) {
    stdout(JSON.stringify(result, null, 2));
  } else {
    printHuman(result, stdout);
    stdout("");
    stdout(`Dataset traces: ${result.traceCount ?? payload.traceIds.length}`);
    stdout(`Allowed: ${result.allowed ?? 0} | Review: ${result.review ?? 0} | Blocked: ${result.blocked ?? 0}`);
  }
  return failThreshold(result.decision, failOn) ? 1 : 0;
}

async function runGatewayDoctor({ args, env, fetchImpl, stdout }) {
  const baseUrl = normalizeBaseUrl(args, env);
  const apiKey = readApiKey(args, env);
  const [policy, metrics, routes] = await Promise.all([
    requestJson(fetchImpl, `${baseUrl}/api/gateway/routing-policy`, { apiKey }),
    requestJson(fetchImpl, `${baseUrl}/api/gateway/metrics`, { apiKey }),
    requestJson(fetchImpl, `${baseUrl}/api/gateway/routes`, { apiKey }),
  ]);
  const checks = [
    {
      id: "routing_policy",
      label: "Routing policy",
      status: policy.ok ? "pass" : "fail",
      evidence: policy.ok ? `strategy=${policy.body.strategy} cache=${Boolean(policy.body.cacheEnabled)}` : `HTTP ${policy.status}`,
      reason: policy.ok ? undefined : errorMessage(policy),
    },
    {
      id: "gateway_metrics",
      label: "Gateway metrics",
      status: metrics.ok ? "pass" : "fail",
      evidence: metrics.ok ? `${metrics.body.totalRequests ?? 0} request(s), ${metrics.body.cacheHits ?? 0} cache hit(s)` : `HTTP ${metrics.status}`,
      reason: metrics.ok ? undefined : errorMessage(metrics),
    },
    {
      id: "route_evidence",
      label: "Route evidence",
      status: routes.ok ? "pass" : "fail",
      evidence: routes.ok ? `${Array.isArray(routes.body) ? routes.body.length : 0} route event(s)` : `HTTP ${routes.status}`,
      reason: routes.ok ? undefined : errorMessage(routes),
    },
  ];
  const summary = summarizeChecks({ baseUrl, apiKey, checks });
  const result = {
    ...summary,
    command: "gateway doctor",
    policy: policy.ok ? policy.body : null,
    metrics: metrics.ok ? metrics.body : null,
    latestRoutes: routes.ok ? routes.body : [],
  };
  if (has(args, "--json")) {
    stdout(JSON.stringify(result, null, 2));
  } else {
    printChecks(summary, stdout);
  }
  return doctorShouldFail(summary, valueOf(args, "--fail-on", "fail")) ? 1 : 0;
}

async function runGatewaySendTest({ args, env, fetchImpl, stdout }) {
  const baseUrl = normalizeBaseUrl(args, env);
  const apiKey = readApiKey(args, env);
  if (!apiKey) {
    throw new Error("NEURALOPS_API_KEY or --api-key is required for gateway send-test");
  }
  const result = await postJson(fetchImpl, `${baseUrl}/api/gateway/openai/v1/chat/completions`, gatewayProbePayload(args), apiKey);
  if (has(args, "--json")) {
    stdout(JSON.stringify(result, null, 2));
  } else {
    stdout(`NeuralOps gateway trace: ${result.neuralops?.traceId || "accepted"}`);
    stdout(`Route: ${result.neuralops?.router?.selectedReason || "unknown"}`);
  }
  return 0;
}

async function runGatewayRoutes({ args, env, fetchImpl, stdout }) {
  const baseUrl = normalizeBaseUrl(args, env);
  const apiKey = readApiKey(args, env);
  const result = await requestJson(fetchImpl, `${baseUrl}/api/gateway/routes`, { apiKey });
  if (!result.ok) {
    throw new Error(errorMessage(result));
  }
  if (has(args, "--json")) {
    stdout(JSON.stringify(result.body, null, 2));
  } else {
    for (const route of result.body || []) {
      stdout(`${route.id} ${route.status || "unknown"} ${route.selectedReason || "unknown"} ${route.cacheStatus || "unknown"}`);
    }
  }
  return 0;
}

async function runGateway({ args, env, fetchImpl, stdout }) {
  const subcommand = args[1];
  if (subcommand === "doctor") {
    return runGatewayDoctor({ args, env, fetchImpl, stdout });
  }
  if (subcommand === "send-test") {
    return runGatewaySendTest({ args, env, fetchImpl, stdout });
  }
  if (subcommand === "routes") {
    return runGatewayRoutes({ args, env, fetchImpl, stdout });
  }
  throw new Error("gateway command must be doctor, send-test, or routes");
}

export async function runCli({
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = globalThis.fetch,
  stdout = console.log,
  stderr = console.error,
} = {}) {
  if (!fetchImpl) {
    stderr("NeuralOps CLI error: fetch is not available in this Node runtime");
    return 2;
  }
  if (argv.length === 0 || has(argv, "--help") || has(argv, "-h")) {
    usage(stdout);
    return argv.length === 0 ? 0 : 0;
  }
  try {
    if (argv[0] === "doctor") {
      return await runDoctor({ args: argv, env, fetchImpl, stdout });
    }
    if (argv[0] === "send-test-trace") {
      return await runSendTestTrace({ args: argv, env, fetchImpl, stdout });
    }
    if ((argv[0] === "release-gate" || argv[0] === "gate") && argv[1] === "run") {
      return await runGate({ args: argv, env, fetchImpl, stdout });
    }
    if (argv[0] === "production" && argv[1] === "ready") {
      return await runProductionReady({ args: argv, env, fetchImpl, stdout });
    }
    if (argv[0] === "replay-gate" && argv[1] === "run") {
      return await runReplayGate({ args: argv, env, fetchImpl, stdout });
    }
    if (argv[0] === "replay-gate" && argv[1] === "dataset") {
      return await runDatasetReplayGate({ args: argv, env, fetchImpl, stdout });
    }
    if (argv[0] === "policy") {
      return await runPolicy({ args: argv, stdout });
    }
    if (argv[0] === "gateway") {
      return await runGateway({ args: argv, env, fetchImpl, stdout });
    }
    usage(stdout);
    return 2;
  } catch (error) {
    stderr(`NeuralOps CLI error: ${error.message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().then((code) => {
    process.exitCode = code;
  });
}
