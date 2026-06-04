#!/usr/bin/env node

const args = process.argv.slice(2);

function valueOf(flag, fallback = undefined) {
  const index = args.indexOf(flag);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

function has(flag) {
  return args.includes(flag);
}

function usage() {
  console.log(`NeuralOps CLI

Commands:
  neuralops release-gate run [options]
  neuralops gate run [options]

Options:
  --base-url <url>             NeuralOps API URL. Defaults to NEURALOPS_API_URL or http://localhost:8000
  --gate-id <id>               Run a saved release gate definition.
  --target <name>              Target environment for ad hoc gates. Default: production
  --max-latency-ms <number>    Ad hoc latency threshold. Default: 2500
  --max-error-rate <number>    Ad hoc error threshold. Default: 0.05
  --min-eval-pass-rate <num>   Ad hoc eval threshold. Default: 0.85
  --require-live-provider      Require a configured live provider.
  --require-auth <bool>        Require auth in gate checks. Default: true
  --fail-on review|block       Exit non-zero on this decision or worse. Default: block
  --json                       Print raw JSON.
`);
}

function boolValue(flag, fallback) {
  if (!args.includes(flag)) return fallback;
  const value = valueOf(flag, "true");
  return !["0", "false", "no"].includes(String(value).toLowerCase());
}

function failThreshold(decision, failOn) {
  if (decision === "block") return true;
  return failOn === "review" && decision === "review";
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { detail: text };
  }
  if (!response.ok) {
    throw new Error(body.detail || `NeuralOps API returned ${response.status}`);
  }
  return body;
}

function printHuman(result) {
  console.log(`NeuralOps release gate: ${result.decision.toUpperCase()} (${result.score}/100)`);
  console.log(`Target: ${result.target}`);
  if (result.gateId) {
    console.log(`Gate: ${result.gateName} (${result.gateId})`);
  }
  console.log("");
  for (const check of result.checks || []) {
    const marker = check.status === "pass" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL";
    console.log(`[${marker}] ${check.label}: ${check.evidence}`);
    if (check.status !== "pass" && process.env.GITHUB_ACTIONS) {
      const level = check.status === "fail" ? "error" : "warning";
      console.log(`::${level} title=${check.label}::${check.reason} ${check.evidence}`);
    }
  }
  if (result.recommendations?.length) {
    console.log("");
    console.log("Recommendations:");
    for (const recommendation of result.recommendations) {
      console.log(`- ${recommendation}`);
    }
  }
}

async function runGate() {
  const baseUrl = (valueOf("--base-url") || process.env.NEURALOPS_API_URL || "http://localhost:8000").replace(/\/$/, "");
  const gateId = valueOf("--gate-id");
  const failOn = valueOf("--fail-on", "block");
  if (!["review", "block"].includes(failOn)) {
    throw new Error("--fail-on must be review or block");
  }
  const payload = gateId
    ? {
        gateId,
        target: valueOf("--target", undefined),
        failOn,
      }
    : {
        target: valueOf("--target", "production"),
        maxLatencyMs: Number(valueOf("--max-latency-ms", "2500")),
        maxErrorRate: Number(valueOf("--max-error-rate", "0.05")),
        minEvalPassRate: Number(valueOf("--min-eval-pass-rate", "0.85")),
        requireLiveProvider: has("--require-live-provider"),
        requireAuth: boolValue("--require-auth", true),
      };
  const endpoint = gateId ? `/api/release-gates/${gateId}/run` : "/api/release-gate/run";
  const result = await postJson(`${baseUrl}${endpoint}`, payload);
  if (has("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(result);
  }
  process.exitCode = failThreshold(result.decision, failOn) ? 1 : 0;
}

if (args.length === 0 || has("--help") || has("-h")) {
  usage();
} else if ((args[0] === "release-gate" || args[0] === "gate") && args[1] === "run") {
  runGate().catch((error) => {
    console.error(`NeuralOps CLI error: ${error.message}`);
    process.exitCode = 2;
  });
} else {
  usage();
  process.exitCode = 2;
}

