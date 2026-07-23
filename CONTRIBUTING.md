# Contributing to NeuralOps

Thanks for improving NeuralOps. Contributions should preserve the project’s central safety property: an agent action must be attributable to a scoped identity and must not bypass authorization, approval, lease binding, revocation, or evidence recording.

## Before you start

1. Search [open issues](https://github.com/Gowrav-M/neuralops-platform/issues) for related work. Open an issue first for a substantial change so scope can be agreed.
2. Do not include credentials, deployment identifiers, customer data, or captured production prompts/outputs in a pull request.
3. Keep changes focused. Update tests and documentation when behavior, config, API contracts, or operator workflow changes.

## Local setup and required checks

The CI workflows currently run these exact commands:

```powershell
npm ci
python -m pip install -r backend/requirements.txt
npm run lint
npm audit --audit-level=high
npm run test:sdk
npm run test:deployment
npm run build
python -m pytest backend
npx playwright install --with-deps chromium
npm run test:e2e
npm run test:e2e:landing
```

The Linux CI workflow uses `npx playwright install --with-deps chromium`. On Windows, use `npx playwright install chromium` instead because Playwright does not support `--with-deps` there. Run the smallest relevant test first, then the complete applicable set before requesting review. For a backend or authorization change, `python -m pytest backend` is required. For UI behavior, run the applicable Playwright commands as well. Do not describe a deployment, provider integration, or security property as verified unless you ran the relevant check against the relevant environment.

## Pull requests

- Use a descriptive title and explain the problem, approach, verification commands/results, documentation impact, and any follow-up work.
- Keep API behavior explicit: return errors rather than silently falling back in a way that disguises missing authorization or unavailable provider configuration.
- Treat permissions, workspace scope, approval binding, idempotency, lease consumption, revocation, and cancellation as regression-sensitive boundaries. Add focused tests for each changed boundary.
- Use least privilege for keys and service integrations. Secrets belong in local/hosted secret storage, not source control.

## Commit format

Use Conventional Commits:

```text
feat: add bounded authorization lease validation
fix: prevent revoked identity from processing queued jobs
docs: clarify local deployment limits
test: cover approval decision idempotency
chore: update development tooling
```

Use `type(scope): summary` when a scope adds clarity. Keep the summary imperative and under 72 characters.

## Code of conduct and security

By participating, you agree to follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). For vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of creating a public issue.
