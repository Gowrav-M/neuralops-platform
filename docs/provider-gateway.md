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

## Security

Set `NEURALOPS_SECRET_KEY` in production. Provider keys are encrypted at rest using this server-side key and are never exposed in API responses.
