#!/usr/bin/env node
import { pathToFileURL } from "node:url";

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

Options:
  --base-url <url>             NeuralOps API URL. Defaults to NEURALOPS_API_URL or http://localhost:8000
  --api-key <key>              NeuralOps API key. Defaults to NEURALOPS_API_KEY
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

async function postJson(fetchImpl, url, payload, apiKey) {
  const result = await requestJson(fetchImpl, url, { method: "POST", payload, apiKey });
  if (!result.ok) {
    throw new Error(errorMessage(result));
  }
  return result.body;
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
