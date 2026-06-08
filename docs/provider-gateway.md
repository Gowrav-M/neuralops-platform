# Provider Gateway

NeuralOps supports live model calls through provider connection records and server environment variables.

## Supported Presets

- OpenAI
- Azure OpenAI-compatible deployment URL
- Anthropic via OpenAI-compatible gateway
- Google Gemini via OpenAI-compatible gateway
- AWS Bedrock via OpenAI-compatible gateway
- Vercel AI Gateway
- OpenRouter
- LiteLLM Proxy
- Groq
- NVIDIA NIM
- Together AI
- Fireworks AI
- Mistral AI
- Cohere
- DeepSeek
- Ollama
- vLLM
- LM Studio
- Custom OpenAI-compatible endpoint

The implementation calls `/chat/completions`, so direct providers that do not expose OpenAI-compatible chat completions should be connected through a gateway such as LiteLLM, OpenRouter, Vercel AI Gateway, or an internal proxy.

## UI Setup

1. Open Settings.
2. Find **AI Provider Gateway Connections**.
3. Choose a provider preset.
4. Confirm base URL, model, environment, and priority.
5. Paste the provider API key if the provider requires one.
6. Save and then run **Test**.

The browser never receives the raw key. It receives only a redacted key preview.

## Environment Setup

Provider env vars are useful for CI and hosted backend deployments. See `.env.example` for supported variables:

- `GROQ_API_KEY`
- `NVIDIA_API_KEY`
- `OPENAI_API_KEY`
- `OPENROUTER_API_KEY`
- `VERCEL_AI_GATEWAY_API_KEY`
- `TOGETHER_API_KEY`
- `FIREWORKS_API_KEY`
- `MISTRAL_API_KEY`
- `DEEPSEEK_API_KEY`
- `NEURALOPS_API_KEY` with `NEURALOPS_PROVIDER_URL`

Local/private providers can be enabled with:

- `OLLAMA_ENABLED=true`
- `VLLM_ENABLED=true`
- `LM_STUDIO_ENABLED=true`

## Runtime Behavior

- `providerMode: local`: deterministic local run only.
- `providerMode: auto`: tries configured live providers, then falls back to local deterministic mode.
- `providerMode: live`: requires a working provider; returns `503` if none succeeds.

Every successful run stores an agent run, trace, eval checks, cost estimate, and audit evidence.

## OpenAI-Compatible Intelligent Gateway Routing

Server apps can send OpenAI-compatible chat completion calls to:

```text
POST /api/gateway/openai/v1/chat/completions
```

NeuralOps routes those calls through configured providers for the requested environment. The routing policy can use:

- `priority`: configured provider priority.
- `lowest_cost`: the lowest known local price estimate.
- `lowest_latency`: observed gateway request latency.
- `balanced`: cost, latency, success rate, provider health, and priority.

For each call it records:

- pre-policy decision
- routing strategy and selected reason
- estimated cost before the provider call
- budget decision
- cache status
- provider attempts and latencies
- failed provider route attempts
- selected provider
- post-policy decision
- trace ID and audit evidence

If the first provider fails, NeuralOps retries with backoff and then tries the next eligible provider instead of failing immediately. If every provider fails, it returns `502 provider_route_failed` with redacted attempt metadata. If no provider exists, it returns `503 not_configured`.

Honest failure behavior:

- `503 not_configured`: no eligible live provider is configured.
- `429 rate_limited`: the NeuralOps API key exceeded the rolling per-minute gateway limit.
- `402 budget_exceeded`: a hard environment budget would be exceeded before provider spend.
- `502 provider_route_failed`: all configured provider attempts failed.

Recent route evidence is available on the **Gateway** page and through:

```text
GET /api/gateway/routes
```

Gateway operating APIs:

```text
GET  /api/gateway/metrics
GET  /api/gateway/requests
GET  /api/gateway/cost-suggestions
GET  /api/gateway/routing-policy
PUT  /api/gateway/routing-policy
GET  /api/gateway/budgets
POST /api/gateway/budgets
PATCH /api/gateway/budgets/{budget_id}
POST /api/gateway/cache/clear
```

Exact-match cache is disabled by default. When enabled, it caches only safe successful responses and still writes a trace, request log, route evidence, and audit event for every cache hit. Semantic cache and Redis-backed rate limits are future production upgrades after the exact-cache path is proven.

## Security

Set `NEURALOPS_SECRET_KEY` in production. Provider keys are encrypted at rest using this server-side key and are never exposed in API responses.
