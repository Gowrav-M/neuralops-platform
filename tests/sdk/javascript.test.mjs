import assert from 'node:assert/strict';
import test from 'node:test';
import { NeuralOps } from '../../sdk/javascript/index.js';
import { runCli } from '../../sdk/javascript/bin/neuralops.mjs';

test('JavaScript SDK routes chat completions through NeuralOps Gateway', async () => {
  const calls = [];
  const client = new NeuralOps({
    apiKey: 'nop_sk_secret_value',
    baseUrl: 'https://neuralops.example',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({ id: 'chatcmpl_test', neuralops: { decision: 'allow', traceId: 'tr_gateway_test' } }),
      };
    },
  });

  const result = await client.chatCompletions({
    model: 'test-model',
    messages: [{ role: 'user', content: 'hello' }],
  });

  assert.equal(result.neuralops.traceId, 'tr_gateway_test');
  assert.equal(calls[0].url, 'https://neuralops.example/api/gateway/openai/v1/chat/completions');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['x-neuralops-key'], 'nop_sk_secret_value');
  assert.equal(JSON.parse(calls[0].options.body).messages[0].content, 'hello');
});

test('JavaScript SDK gateway errors do not include full API keys', async () => {
  const client = new NeuralOps({
    apiKey: 'nop_sk_secret_value',
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      text: async () => '{"detail":"blocked by policy"}',
    }),
  });

  await assert.rejects(
    () => client.chatCompletions({ messages: [{ role: 'user', content: 'unsafe' }] }),
    (error) => {
      assert.equal(error.message.includes('nop_sk_secret_value'), false);
      assert.equal(error.message.includes('blocked by policy'), true);
      return true;
    },
  );
});

test('JavaScript CLI doctor verifies health and writes a test trace without leaking keys', async () => {
  const calls = [];
  const output = [];
  const code = await runCli({
    argv: ['doctor', '--base-url', 'https://neuralops.example', '--api-key', 'nop_sk_secret_value', '--json'],
    env: {},
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(line),
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith('/health')) {
        return jsonResponse(200, { ok: true, service: 'neuralops-api', storage: 'postgres' });
      }
      if (url.endsWith('/api/traces/ingest')) {
        return jsonResponse(200, { trace: { id: 'tr_sdk_doctor' } });
      }
      return jsonResponse(404, { detail: 'not found' });
    },
  });

  const result = JSON.parse(output.join('\n'));
  assert.equal(code, 0);
  assert.equal(result.status, 'pass');
  assert.equal(result.checks.find((check) => check.id === 'trace_ingest').status, 'pass');
  assert.equal(calls[1].options.headers['x-neuralops-key'], 'nop_sk_secret_value');
  assert.equal(output.join('\n').includes('nop_sk_secret_value'), false);
});

test('JavaScript CLI doctor treats an unconfigured gateway as an honest warning', async () => {
  const output = [];
  const code = await runCli({
    argv: [
      'doctor',
      '--base-url',
      'https://neuralops.example',
      '--api-key',
      'nop_sk_secret_value',
      '--check-gateway',
      '--json',
    ],
    env: {},
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(line),
    fetchImpl: async (url) => {
      if (url.endsWith('/health')) {
        return jsonResponse(200, { ok: true, service: 'neuralops-api', storage: 'postgres' });
      }
      if (url.endsWith('/api/traces/ingest')) {
        return jsonResponse(200, { traceId: 'tr_gateway_probe' });
      }
      if (url.endsWith('/api/gateway/openai/v1/chat/completions')) {
        return jsonResponse(503, { detail: { code: 'not_configured', message: 'No provider configured' } });
      }
      return jsonResponse(404, { detail: 'not found' });
    },
  });

  const result = JSON.parse(output.join('\n'));
  assert.equal(code, 0);
  assert.equal(result.status, 'warn');
  assert.equal(result.checks.find((check) => check.id === 'gateway').status, 'warn');
  assert.equal(result.checks.find((check) => check.id === 'gateway').evidence.includes('refused fake output'), true);
});

test('JavaScript CLI send-test-trace stores a connectivity trace', async () => {
  const output = [];
  const code = await runCli({
    argv: [
      'send-test-trace',
      '--base-url',
      'https://neuralops.example',
      '--api-key',
      'nop_sk_secret_value',
      '--environment',
      'production',
      '--json',
    ],
    env: {},
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(line),
    fetchImpl: async (url, options = {}) => {
      assert.equal(url, 'https://neuralops.example/api/traces/ingest');
      assert.equal(JSON.parse(options.body).environment, 'production');
      return jsonResponse(200, { traceId: 'tr_cli_trace' });
    },
  });

  const result = JSON.parse(output.join('\n'));
  assert.equal(code, 0);
  assert.equal(result.traceId, 'tr_cli_trace');
});

test('JavaScript CLI release-gate still exits non-zero on blocking decisions', async () => {
  const output = [];
  const code = await runCli({
    argv: ['release-gate', 'run', '--base-url', 'https://neuralops.example', '--json'],
    env: {},
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(line),
    fetchImpl: async (url, options = {}) => {
      assert.equal(url, 'https://neuralops.example/api/release-gate/run');
      assert.equal(JSON.parse(options.body).target, 'production');
      return jsonResponse(200, {
        decision: 'block',
        score: 40,
        target: 'production',
        checks: [{ label: 'Synthetic Production Canary', status: 'fail', evidence: 'stale' }],
      });
    },
  });

  assert.equal(code, 1);
  assert.equal(JSON.parse(output.join('\n')).decision, 'block');
});

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}
