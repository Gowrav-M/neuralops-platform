import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function readRepositoryFile(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), 'utf8');
}

test('Docker quickstart keeps local services loopback-bound, non-root, and secret-free', async () => {
  const [compose, frontendDockerfile, backendDockerfile, nginxConfig, dockerignore] = await Promise.all([
    readRepositoryFile('compose.yaml'),
    readRepositoryFile('Dockerfile'),
    readRepositoryFile('backend/Dockerfile'),
    readRepositoryFile('docker/nginx.conf'),
    readRepositoryFile('.dockerignore'),
  ]);

  assert.match(compose, /127\.0\.0\.1:8000:8000/);
  assert.match(compose, /127\.0\.0\.1:5173:8080/);
  assert.match(compose, /NEURALOPS_DB_PATH:\s*\/data\/neuralops\.sqlite3/);
  assert.match(compose, /NEURALOPS_AUTH_REQUIRED:\s*["']?false["']?/);
  assert.match(compose, /NEURALOPS_ENVIRONMENT:\s*local/);
  assert.match(compose, /NEURALOPS_CORS_ORIGINS:\s*http:\/\/localhost:5173/);
  assert.match(compose, /NEURALOPS_DELIVERY_SEND_ENABLED:\s*["']?false["']?/);
  assert.match(compose, /NEURALOPS_GITHUB_SEND_ENABLED:\s*["']?false["']?/);
  assert.match(compose, /condition:\s*service_healthy/);
  assert.match(compose, /neuralops_sqlite_data:/);
  assert.match(compose, /read_only:\s*true/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /cap_drop:\s*\n\s*- ALL/);
  assert.match(compose, /VITE_API_BASE_URL:\s*http:\/\/localhost:8000/);
  assert.doesNotMatch(compose, /(?:GITHUB_TOKEN|API_KEY|SECRET|PASSWORD):/);

  assert.match(frontendDockerfile, /FROM\s+node:[^\s]+\s+AS\s+build/i);
  assert.match(frontendDockerfile, /FROM\s+nginxinc\/nginx-unprivileged:/i);
  assert.match(frontendDockerfile, /USER\s+101/);
  assert.match(frontendDockerfile, /VITE_API_BASE_URL/);
  assert.match(frontendDockerfile, /HEALTHCHECK/);
  assert.match(backendDockerfile, /COPY\s+backend\/requirements\.txt/);
  assert.match(backendDockerfile, /USER\s+neuralops/);
  assert.match(backendDockerfile, /HEALTHCHECK/);
  assert.match(backendDockerfile, /\$\{PORT:-8000\}/);
  assert.match(nginxConfig, /try_files\s+\$uri\s+\$uri\/\s+\/index\.html/);
  assert.match(dockerignore, /\.env/);
  assert.match(dockerignore, /node_modules/);
});
