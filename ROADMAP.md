# Roadmap

This roadmap describes direction, not a delivery promise. Priorities may change based on maintainability, security findings, and contributor capacity.

## Next

- Harden and document the agent-control lifecycle with more concurrency, revocation, and recovery coverage.
- Improve installation and self-hosting guidance, including a reproducible container workflow.
- Expand release-gate and replay evidence coverage while keeping decision inputs inspectable.
- Improve OpenTelemetry ingestion and export interoperability.
- Make database, auth, retention, and operational readiness defaults easier to verify for self-hosters.

## Later

- Broaden policy authoring, evaluation, and evidence-export ergonomics.
- Improve provider gateway observability and failure handling without masking unavailable dependencies.
- Strengthen accessibility and operator workflow testing across the console.

## Non-goals

NeuralOps does not promise to make arbitrary agent actions safe automatically, replace human incident response, guarantee provider behavior, or provide compliance certification.
