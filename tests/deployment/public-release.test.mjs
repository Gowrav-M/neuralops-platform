import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function readRepositoryFile(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), 'utf8');
}

function assertBefore(content, earlier, later) {
  const earlierIndex = content.indexOf(earlier);
  const laterIndex = content.indexOf(later);
  assert.notEqual(earlierIndex, -1, `missing ${earlier}`);
  assert.notEqual(laterIndex, -1, `missing ${later}`);
  assert.ok(earlierIndex < laterIndex, `${earlier} must precede ${later}`);
}

function stepBlock(workflow, stepName) {
  const start = workflow.indexOf(`- name: ${stepName}`);
  assert.notEqual(start, -1, `missing step ${stepName}`);
  const next = workflow.indexOf('\n      - ', start + 1);
  return workflow.slice(start, next === -1 ? undefined : next);
}

function assertThirdPartyActionsAreImmutable(workflow) {
  const uses = [...workflow.matchAll(/^\s*(?:-\s+)?uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)];
  assert.ok(uses.length > 0, 'expected workflow actions');
  for (const match of uses) {
    const reference = match[1];
    const [action] = reference.split('@');
    if (action.startsWith('actions/') || action.startsWith('github/')) {
      continue;
    }
    assert.match(reference, /@[a-f0-9]{40}$/i, `third-party action must be SHA-pinned: ${reference}`);
  }
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
  assert.doesNotMatch(ci, /gitleaks\/gitleaks-action/);
  assert.match(ci, /fetch-depth:\s*0/);
  assert.match(ci, /gitleaks_8\.30\.1_linux_x64\.tar\.gz/);
  assert.match(ci, /551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb/);
  assert.match(ci, /gitleaks git --redact=100 --no-banner --log-opts=--all \./);
  assert.match(ci, /Apache-2\.0/);

  assert.match(codeql, /github\/codeql-action\/init@v4/);
  assert.match(codeql, /javascript-typescript/);
  assert.match(codeql, /python/);
  assert.match(dependencyReview, /actions\/dependency-review-action@v5/);
  for (const ecosystem of ['npm', 'pip', 'github-actions', 'docker']) {
    assert.match(dependabot, new RegExp(`package-ecosystem: ['\"]?${ecosystem}`));
  }
  assert.match(dependabot, /package-ecosystem: docker\s+directory: \/backend/);

  assert.match(backendImage, /github\.repository == 'Gowrav-M\/neuralops-platform'/);
  assert.match(backendImage, /docker\/setup-buildx-action@e468171a9de216ec08956ac3ada2f0791b6bd435\s+# v3/);
  assert.match(backendImage, /docker\/build-push-action@263435318d21b8e681c14492fe198d362a7d2c83\s+# v6/);
  assert.match(backendImage, /docker\/login-action@9780b0c442fbb1117ed29e0efdff1e18412f7567\s+# v3/);
  assert.doesNotMatch(backendImage, /\n    paths:/);
  assert.match(backendImage, /Validate version tag before publishing/);
  assert.match(backendImage, /\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/);
  assert.match(backendImage, /GITHUB_REF_NAME#v/);
  assert.match(backendImage, /aquasecurity\/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25\s+# v0\.36\.0/);
  assert.match(backendImage, /exit-code:\s*['\"]?1/);
  assert.match(backendImage, /severity:\s*HIGH,CRITICAL/);
  assertBefore(backendImage, 'Validate version tag before publishing', 'Authenticate to GitHub Container Registry');
  assertThirdPartyActionsAreImmutable(backendImage);
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
  assert.match(production, /packages:\s*read/);
  assert.match(production, /Authenticate to GitHub Container Registry/);
  assert.match(production, /Resolve immutable backend image digest/);
  assert.match(production, /docker buildx imagetools inspect/);
  assert.match(production, /ghcr\.io\/gowrav-m\/neuralops-api@\$\{image_digest\}/);
  assert.match(production, /artifacts\/image-preflight\.json/);
  assert.match(production, /NEURALOPS_QA_AUTH_TOKEN/);
  assert.match(production, /NEURALOPS_WORKSPACE_ID/);
  assert.match(production, /verify_supabase_rls\.py/);
  assert.match(production, /verify-deployment\.mjs/);
  assert.match(production, /artifacts\/migration-verification\.json/);
  assert.match(production, /artifacts\/readiness\.json/);
  assert.match(production, /if-no-files-found:\s*error/);
  assert.match(production, /retention-days:/);
  assertBefore(production, 'Resolve immutable backend image digest', 'Apply reviewed Supabase migration');
  const deploymentJobHeader = production.slice(production.indexOf('  deploy:'), production.indexOf('\n    steps:'));
  assert.doesNotMatch(deploymentJobHeader, /secrets\./);
  assert.match(stepBlock(production, 'Validate required production configuration'), /secrets\.DATABASE_URL/);
  assert.match(stepBlock(production, 'Validate required production configuration'), /secrets\.RENDER_API_KEY/);
  assert.match(stepBlock(production, 'Apply reviewed Supabase migration'), /secrets\.DATABASE_URL/);
  assert.doesNotMatch(stepBlock(production, 'Apply reviewed Supabase migration'), /RENDER_API_KEY|NEURALOPS_QA_AUTH_TOKEN/);
  assert.match(stepBlock(production, 'Deploy immutable image to Render'), /secrets\.RENDER_API_KEY/);
  assert.match(stepBlock(production, 'Deploy immutable image to Render'), /secrets\.RENDER_SERVICE_ID/);
  assert.match(stepBlock(production, 'Verify Supabase row-level security'), /secrets\.DATABASE_URL/);
  const acceptance = stepBlock(production, 'Run authenticated production acceptance');
  assert.match(acceptance, /secrets\.NEURALOPS_QA_AUTH_TOKEN/);
  assert.match(acceptance, /secrets\.NEURALOPS_QA_WORKSPACE_ID/);
  assert.match(acceptance, /NEURALOPS_DEPLOYED_API_URL/);
  assert.match(acceptance, /NEURALOPS_DEPLOYED_FRONTEND_URL/);
  assert.match(production, /docker\/setup-buildx-action@e468171a9de216ec08956ac3ada2f0791b6bd435\s+# v3/);
  assert.match(production, /docker\/login-action@9780b0c442fbb1117ed29e0efdff1e18412f7567\s+# v3/);
  assertThirdPartyActionsAreImmutable(production);

  assert.match(release, /tags:\s*\[v\*\]/);
  assert.match(release, /v\[0-9\]/);
  assert.match(release, /SHA256SUMS/);
  assert.match(release, /aquasecurity\/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25\s+# v0\.36\.0/);
  assert.match(release, /anchore\/sbom-action@e22c389904149dbc22b58101806040fa8d37a610\s+# v0/);
  assert.match(release, /softprops\/action-gh-release@c12583777ecdfd3be55c69cf75464299dc01057e\s+# v3/);
  assertBefore(release, 'Fail on high or critical release image vulnerabilities', 'Export backend release image');
  const attestedSubjects = [
    'artifacts/neuralops-frontend.tar.gz',
    'artifacts/neuralops-backend-image.tar.gz',
    'artifacts/neuralops-backend.spdx.json',
    'artifacts/SHA256SUMS',
  ];
  for (const subject of attestedSubjects) {
    assert.match(release, new RegExp(`subject-path: ${subject.replaceAll('.', '\\.')}`));
  }
  assert.match(release, /docker\/setup-buildx-action@e468171a9de216ec08956ac3ada2f0791b6bd435\s+# v3/);
  assert.match(release, /docker\/build-push-action@263435318d21b8e681c14492fe198d362a7d2c83\s+# v6/);
  assertThirdPartyActionsAreImmutable(release);
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
