import assert from 'node:assert/strict';
import test from 'node:test';
import { NeuralOps } from '../../sdk/javascript/index.js';

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
