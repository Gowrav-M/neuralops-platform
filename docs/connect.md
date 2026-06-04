# Connect Real AI Apps

NeuralOps is useful only when real traces enter the backend. The Connect workflow gives a developer one path to prove that:

1. Create an ingest key from the Connect page or Settings page with the `trace:ingest` scope.
2. Store the key in the server environment as `NEURALOPS_API_KEY`.
3. Send traces through the JavaScript SDK, Python SDK, REST endpoint, or OpenTelemetry endpoint.
4. Run "Verify Connection + Store Trace" to write a real trace and audit event.
5. Open Dashboard, Traces, Evaluations, Costs, and Evidence to see the backend state update.

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

- Keep ingest keys server-side.
- Use the narrowest key scope possible. `trace:read` keys cannot ingest traces, while `trace:ingest` keys can write trace and OTEL records.
- Rotate keys before any public deployment if a key was pasted into chat, logs, screenshots, or Git.
- Do not send raw provider secrets in prompts, outputs, tool calls, or trace metadata.
- Treat prompt and output capture as sensitive production telemetry.
