# neuralops-sdk

Local Python SDK for sending real AI workflow traces into NeuralOps.

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
```

Keep the API key on the server. Do not expose it in browser JavaScript.

