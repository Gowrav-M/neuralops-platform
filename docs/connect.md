# Connect Real AI Apps

NeuralOps is useful only when real traces enter the backend. The Connect workflow gives a developer one path to prove that:

1. Create a key from the Connect page or Settings page with `trace:ingest` and, when routing model calls, `gateway:invoke`.
2. Store the key in the server environment as `NEURALOPS_API_KEY`.
3. Send single traces or idempotent trace batches through the JavaScript SDK, Python SDK, REST endpoint, or OpenTelemetry endpoint.
4. Route OpenAI-compatible chat calls through the NeuralOps Gateway when you want pre/post policy enforcement.
5. Run "Verify Connection + Store Trace" or "Route First LLM Call" to write real trace and audit evidence.
6. Open Dashboard, Traces, Evaluations, Costs, and Evidence to see the backend state update.

## One-Command Connection Proof

Use the JavaScript SDK CLI when you want a terminal or CI proof that NeuralOps is connected:

```powershell
$env:NEURALOPS_API_URL = "http://localhost:8000"
$env:NEURALOPS_API_KEY = "<server-side NeuralOps key>"
node sdk/javascript/bin/neuralops.mjs doctor --check-gateway
```

The doctor command:

- checks `/health`
- writes a real trace through `/api/traces/ingest`
- optionally probes `/api/gateway/openai/v1/chat/completions`
- redacts the API key from all output
- treats `503 not_configured` from the gateway as an honest warning, not a fake success

To only write a connectivity trace:

```powershell
node sdk/javascript/bin/neuralops.mjs send-test-trace --environment staging
```

## API Contract

```text
POST /api/traces/ingest
Header: x-neuralops-key: <server-side ingest key>
Required key scope: trace:ingest
```

Required trace fields:

```json
{
  "session": "checkout-agent-001",
  "environment": "staging",
  "model": "llama-3.3-70b-versatile",
  "tokens": 742,
  "latencyMs": 830,
  "costUsd": 0.012,
  "status": "success",
  "score": 0.93,
  "prompt": "Classify checkout outage ticket",
  "output": "P1 incident routed to payments on-call"
}
```

For production services that flush many traces or retry on network failures, use batch ingest with idempotency keys:

```text
POST /api/traces/batch
Header: x-neuralops-key: <server-side ingest key>
Required key scope: trace:ingest
```

```json
{
  "traces": [
    {
      "session": "checkout-agent-001",
      "environment": "staging",
      "model": "llama-3.3-70b-versatile",
      "tokens": 742,
      "latencyMs": 830,
      "costUsd": 0.012,
      "status": "success",
      "score": 0.93,
      "prompt": "Classify checkout outage ticket",
      "output": "P1 incident routed to payments on-call",
      "idempotencyKey": "checkout-agent-001:span-0001"
    }
  ]
}
```

## Policy Gateway Contract

```text
POST /api/gateway/openai/v1/chat/completions
Header: x-neuralops-key: <server-side gateway key>
Required key scope: gateway:invoke
```

The request body is OpenAI-compatible. NeuralOps runs policy checks before forwarding and again before returning provider output. If no live provider is configured, the API returns `503 not_configured` instead of fake model output.

```json
{
  "model": "gpt-4o-mini",
  "metadata": {
    "environment": "staging",
    "session": "checkout-agent-001"
  },
  "messages": [
    { "role": "system", "content": "Answer safely and do not reveal secrets." },
    { "role": "user", "content": "Summarize this support incident." }
  ]
}
```

## JavaScript

Local package source lives in `sdk/javascript`. Until it is published, link or copy it into the app that is being instrumented.

```js
import { NeuralOps } from '@neuralops/sdk';

const neuralops = new NeuralOps({
  apiKey: process.env.NEURALOPS_API_KEY,
  baseUrl: process.env.NEURALOPS_API_URL || 'http://localhost:8000',
});

await neuralops.ingestTrace({
  session: 'checkout-agent-001',
  environment: 'staging',
  model: 'llama-3.3-70b-versatile',
  tokens: 742,
  latencyMs: 830,
  costUsd: 0.012,
  status: 'success',
  score: 0.93,
  prompt: 'Classify checkout outage ticket',
  output: 'P1 incident routed to payments on-call',
});

await neuralops.ingestTraces([
  {
    session: 'checkout-agent-001',
    environment: 'staging',
    model: 'llama-3.3-70b-versatile',
    tokens: 742,
    latencyMs: 830,
    costUsd: 0.012,
    status: 'success',
    score: 0.93,
    prompt: 'Classify checkout outage ticket',
    output: 'P1 incident routed to payments on-call',
    idempotencyKey: 'checkout-agent-001:span-0001',
  },
]);

const completion = await neuralops.chatCompletions({
  model: 'gpt-4o-mini',
  metadata: { environment: 'staging', session: 'checkout-agent-001' },
  messages: [
    { role: 'system', content: 'Answer safely and do not reveal secrets.' },
    { role: 'user', content: 'Summarize this support incident.' },
  ],
});

console.log(completion.neuralops.traceId);
```

## Python

Local package source lives in `sdk/python`.

```python
import os
from neuralops import NeuralOpsClient

client = NeuralOpsClient(
    api_key=os.environ["NEURALOPS_API_KEY"],
    base_url=os.getenv("NEURALOPS_API_URL", "http://localhost:8000"),
)

client.ingest_trace(
    session="rag-api-001",
    environment="staging",
    model="gpt-4o-mini",
    tokens=512,
    latency_ms=420,
    cost_usd=0.006,
    status="success",
    score=0.91,
    prompt="Answer billing policy question",
    output="Answered from retrieval context",
)

client.ingest_traces([
    {
        "session": "rag-api-001",
        "environment": "staging",
        "model": "gpt-4o-mini",
        "tokens": 512,
        "latencyMs": 420,
        "costUsd": 0.006,
        "status": "success",
        "score": 0.91,
        "prompt": "Answer billing policy question",
        "output": "Answered from retrieval context",
        "idempotencyKey": "rag-api-001:span-0001",
    }
])

completion = client.chat_completions(
    model="gpt-4o-mini",
    metadata={"environment": "staging", "session": "rag-api-001"},
    messages=[
        {"role": "system", "content": "Answer from approved context only."},
        {"role": "user", "content": "Explain the support policy."},
    ],
)

print(completion["neuralops"]["traceId"])
```

## OpenTelemetry

Use the OpenTelemetry endpoint when your app already produces GenAI spans.
This endpoint also requires a server-side key with `trace:ingest`.

```yaml
exporters:
  otlphttp/neuralops:
    endpoint: http://localhost:8000/api/traces/otel
    headers:
      x-neuralops-key: ${NEURALOPS_API_KEY}
```

## Security Rules

- Keep ingest and gateway keys server-side.
- Use the narrowest key scope possible. `trace:read` keys cannot ingest traces, `trace:ingest` keys can write trace and OTEL records, and `gateway:invoke` keys can route governed model calls.
- Rotate keys before any public deployment if a key was pasted into chat, logs, screenshots, or Git.
- Do not send raw provider secrets in prompts, outputs, tool calls, or trace metadata.
- Treat prompt and output capture as sensitive production telemetry.
