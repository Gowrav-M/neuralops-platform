# NeuralOps Integration Kit

The Integration Kit lets an application send real traces into NeuralOps without replacing its existing model provider.

## JavaScript

```js
import OpenAI from "openai";
import { NeuralOps, wrapOpenAI, traceFunction } from "../sdk/javascript/index.js";

const neuralops = new NeuralOps({
  apiKey: process.env.NEURALOPS_API_KEY,
  baseUrl: process.env.NEURALOPS_API_URL,
});

const openai = wrapOpenAI(new OpenAI({ apiKey: process.env.OPENAI_API_KEY }), {
  neuralops,
  session: "checkout-agent-001",
  environment: "staging",
});

await openai.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Summarize this support ticket." }],
});

await traceFunction("rerank-documents", async () => rerankDocuments(), {
  neuralops,
  session: "checkout-agent-001",
  prompt: "Rerank retrieved support docs.",
});

await neuralops.ingestTraces([
  {
    session: "checkout-agent-001",
    environment: "staging",
    model: "gpt-4o-mini",
    tokens: 320,
    latencyMs: 180,
    costUsd: 0.004,
    status: "success",
    score: 0.94,
    prompt: "Rerank retrieved support docs.",
    output: "Selected policy chunk 3.",
    idempotencyKey: "checkout-agent-001:rerank-0001",
  },
]);
```

`wrapOpenAI` and `traceFunction` fail open by default: if NeuralOps is temporarily unavailable, the application keeps running. Use `strict: true` only for CI or controlled release checks.

## Python

```python
from neuralops import NeuralOpsClient, trace_function, wrap_openai

neuralops = NeuralOpsClient(
    api_key=os.environ["NEURALOPS_API_KEY"],
    base_url=os.environ["NEURALOPS_API_URL"],
)

client = wrap_openai(
    neuralops,
    openai_client,
    session="checkout-agent-001",
    environment="staging",
)

client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "Summarize this support ticket."}],
)

trace_function(
    neuralops,
    "rerank-documents",
    lambda: rerank_documents(),
    session="checkout-agent-001",
    prompt="Rerank retrieved support docs.",
)

neuralops.ingest_traces([
    {
        "session": "checkout-agent-001",
        "environment": "staging",
        "model": "gpt-4o-mini",
        "tokens": 320,
        "latencyMs": 180,
        "costUsd": 0.004,
        "status": "success",
        "score": 0.94,
        "prompt": "Rerank retrieved support docs.",
        "output": "Selected policy chunk 3.",
        "idempotencyKey": "checkout-agent-001:rerank-0001",
    }
])
```

Use batch ingest when a service flushes many traces or retries after a network failure. NeuralOps deduplicates repeated envelopes with the same `idempotencyKey`.

The SDK never logs provider keys or NeuralOps keys. Keys stay server-side.
