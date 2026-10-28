# Roadmap

This roadmap describes direction, not a delivery promise. Priorities may change based on maintainability, security findings, and contributor capacity.

## Next

- Validate MCP and OpenAI Agents SDK adapters with real self-hosted users; prioritize compatibility fixes and tool-boundary failure cases from reproducible reports.
- Harden approval resume, revocation races, ambiguous side-effect recovery, and privacy-policy transitions before broadening framework support.
- Improve clean-clone installability, SDK release automation, compatibility tests, and focused integration examples.
- Measure whether developers can identify the blocked action, approve the right request, and safely resume it without retaining raw arguments by default.

## Later

- Consider additional runtime adapters only when user reports show demand and the existing adapter contracts remain maintainable.
- Broaden policy authoring, evaluation, and evidence-export ergonomics.
- Improve provider gateway observability and failure handling without masking unavailable dependencies.
- Strengthen accessibility and operator workflow testing across the console.

## Non-goals

NeuralOps does not promise to make arbitrary agent actions safe automatically, replace human incident response, guarantee provider behavior, or provide compliance certification.
