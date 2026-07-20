import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function readRepositoryFile(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), 'utf8');
}

test('public CI and release automation keeps protected contexts and supply-chain controls', async () => {
  const [ci, gate, backendImage, codeql, dependencyReview, dependabot] = await Promise.all([
    readRepositoryFile('.github/workflows/ci.yml'),
    readRepositoryFile('.github/workflows/release-gate.yml'),
    readRepositoryFile('.github/workflows/backend-image.yml'),
    readRepositoryFile('.github/workflows/codeql.yml'),
    readRepositoryFile('.github/workflows/dependency-review.yml'),
    readRepositoryFile('.github/dependabot.yml'),
  ]);

  for (const job of ['verify', 'security-audit', 'e2e']) {
    assert.match(ci, new RegExp(`^\\s{2}${job}:`, 'm'));
  }
  assert.match(gate, /^\s{2}gate:/m);
  assert.match(ci, /npm run lint/);
  assert.match(ci, /npm audit --audit-level=high/);
  assert.match(ci, /npm run build/);
  assert.match(ci, /npm run test:sdk/);
  assert.match(ci, /npm run test:deployment/);
  assert.match(ci, /python -m pytest backend/);
  assert.match(ci, /pip_audit/);
  assert.match(ci, /playwright/);
  assert.match(ci, /gitleaks\/gitleaks-action@v3/);
  assert.match(ci, /fetch-depth:\s*0/);
  assert.match(ci, /redact/);
  assert.match(ci, /Apache-2\.0/);

  assert.match(codeql, /github\/codeql-action\/init@v4/);
  assert.match(codeql, /javascript-typescript/);
  assert.match(codeql, /python/);
  assert.match(dependencyReview, /actions\/dependency-review-action@v5/);
  for (const ecosystem of ['npm', 'pip', 'github-actions', 'docker']) {
    assert.match(dependabot, new RegExp(`package-ecosystem: ['\"]?${ecosystem}`));
  }

  assert.match(backendImage, /github\.repository == 'Gowrav-M\/neuralops-platform'/);
  assert.match(backendImage, /docker\/build-push-action@v6/);
  assert.match(backendImage, /aquasecurity\/trivy-action@0\.36\.0/);
  assert.match(backendImage, /exit-code:\s*['\"]?1/);
  assert.match(backendImage, /severity:\s*HIGH,CRITICAL/);
  assert.doesNotMatch(backendImage, /RENDER_API_KEY|DATABASE_URL|verify-deployment|migration/i);
});

test('production deployment is owner-only and release publishing is tag-driven and attestable', async () => {
  const [production, release, codeowners, pullRequest, bug, feature, goodFirst, security] = await Promise.all([
    readRepositoryFile('.github/workflows/deploy-production.yml'),
    readRepositoryFile('.github/workflows/release.yml'),
    readRepositoryFile('.github/CODEOWNERS'),
    readRepositoryFile('.github/pull_request_template.md'),
    readRepositoryFile('.github/ISSUE_TEMPLATE/bug_report.yml'),
    readRepositoryFile('.github/ISSUE_TEMPLATE/feature_request.yml'),
    readRepositoryFile('.github/ISSUE_TEMPLATE/good_first_issue.yml'),
    readRepositoryFile('.github/ISSUE_TEMPLATE/config.yml'),
  ]);

  assert.match(production, /workflow_dispatch:/);
  assert.doesNotMatch(production, /pull_request(?:_target)?:/);
  assert.match(production, /github\.repository == 'Gowrav-M\/neuralops-platform'/);
  assert.match(production, /github\.ref == 'refs\/heads\/main'/);
  assert.match(production, /environment:\s*production/);
  assert.match(production, /concurrency:/);
  assert.match(production, /secrets\.RENDER_SERVICE_ID/);
  assert.doesNotMatch(production, /srv-[A-Za-z0-9]+/);
  assert.match(production, /secrets\.DATABASE_URL/);
  assert.match(production, /secrets\.RENDER_API_KEY/);
  assert.match(production, /NEURALOPS_QA_AUTH_TOKEN/);
  assert.match(production, /NEURALOPS_WORKSPACE_ID/);
  assert.match(production, /verify_supabase_rls\.py/);
  assert.match(production, /verify-deployment\.mjs/);
  assert.match(production, /retention-days:/);

  assert.match(release, /tags:\s*\[v\*\]/);
  assert.match(release, /v\[0-9\]/);
  assert.match(release, /SHA256SUMS/);
  assert.match(release, /anchore\/sbom-action@v0/);
  assert.match(release, /actions\/attest-build-provenance@v4/);
  assert.match(release, /softprops\/action-gh-release@v3/);
  assert.doesNotMatch(release, /deploy-production/i);
  assert.doesNotMatch(release, /pull_request_target:/);

  assert.match(codeowners, /@Gowrav-M/);
  assert.match(pullRequest, /Security|security/i);
  for (const form of [bug, feature, goodFirst]) {
    assert.match(form, /name:/);
    assert.match(form, /body:/);
  }
  assert.match(security, /security\/advisories\/new/);
});
