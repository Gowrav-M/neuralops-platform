# neuralops-sdk

Local Python SDK for sending real AI workflow traces into NeuralOps and routing OpenAI-compatible model calls through the NeuralOps Policy Gateway.

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
    model="llama-3.3-70b-versatile",
    tokens=512,
    latency_ms=420,
    cost_usd=0.006,
    status="success",
    score=0.91,
    prompt="Answer billing policy question",
    output="Answered from retrieval context",
)

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

Keep the API key on the server. Use `trace:ingest` for telemetry and `gateway:invoke` for governed model calls. Do not expose keys in browser JavaScript.
