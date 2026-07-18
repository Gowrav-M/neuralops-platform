from collections.abc import Generator
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
from threading import Event
from typing import Any

import jwt
import pytest
from fastapi.testclient import TestClient

from app import database
import app.job_queue as job_queue
from app.main import app


TEST_JWT_SECRET = "job-lifecycle-test-secret-at-least-32"


def auth_header(email: str, workspace_id: str) -> dict[str, str]:
    token = jwt.encode(
        {
            "sub": email,
            "email": email,
            "app_metadata": {"neuralops_workspace_id": workspace_id},
        },
        TEST_JWT_SECRET,
        algorithm="HS256",
    )
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture()
def secure_client(tmp_path: Path) -> Generator[TestClient]:
    database.DB_PATH = tmp_path / "job-lifecycle.sqlite3"
    database.POSTGRES_URL = None
    os.environ["NEURALOPS_DB_PATH"] = str(database.DB_PATH)
    os.environ["NEURALOPS_AUTH_REQUIRED"] = "true"
    os.environ["SUPABASE_JWT_SECRET"] = TEST_JWT_SECRET
    try:
        with TestClient(app) as test_client:
            yield test_client
    finally:
        os.environ.pop("NEURALOPS_AUTH_REQUIRED", None)
        os.environ.pop("SUPABASE_JWT_SECRET", None)


def register_agent(client: TestClient, workspace_id: str) -> tuple[dict[str, str], dict[str, Any]]:
    owner = auth_header(f"owner-{workspace_id}@example.com", workspace_id)
    assert client.get("/api/workspace", headers=owner).status_code == 200
    response = client.post(
        "/api/agent-control/identities",
        headers=owner,
        json={
            "displayName": "Lifecycle worker",
            "owner": f"owner-{workspace_id}@example.com",
            "environment": "all",
            "permissions": ["agent:run", "metadata:read"],
            "providerAccess": ["local"],
        },
    )
    assert response.status_code == 200
    return owner, response.json()


def save_job(
    workspace_id: str,
    job_id: str,
    agent_id: str,
    *,
    environment: str = "staging",
    lease_id: str | None = None,
    context_hash: str | None = None,
) -> None:
    database.save_record(
        "agent_jobs",
        f"{workspace_id}:{job_id}",
        {
            "id": job_id,
            "workspaceId": workspace_id,
            "status": "queued",
            "request": {
                "agentId": agent_id,
                "input": f"sha256:{'a' * 64}",
                "providerMode": "local",
                "provider": "local",
                "model": "local-policy-engine",
                "environment": environment,
                "authorizationLeaseId": lease_id,
                "authorizationContextHash": context_hash,
            },
            "attempts": 0,
            "maxAttempts": 2,
            "createdAt": "2026-07-16T09:00:00+00:00",
            "updatedAt": "2026-07-16T09:00:00+00:00",
        },
    )


def save_active_lease(
    workspace_id: str,
    lease_id: str,
    identity_id: str,
    content_hash: str,
    context_hash: str,
    *,
    environment: str = "staging",
) -> None:
    database.save_record(
        "agent_authorization_leases",
        f"{workspace_id}:{lease_id}",
        {
            "id": lease_id,
            "workspaceId": workspace_id,
            "identityId": identity_id,
            "action": "agent_run",
            "toolCategory": "agent_runtime",
            "operation": "execute",
            "contextHash": context_hash,
            "contentHash": content_hash,
            "provider": "local",
            "model": "local-policy-engine",
            "environment": environment,
            "risk": "high",
            "status": "active",
            "idempotencyKey": f"idem-{lease_id}",
            "createdAt": "2026-07-16T09:00:00",
            "expiresAt": "2099-07-16T09:05:00",
        },
    )


def matching_jobs(workspace_id: str, agent_id: str) -> list[dict[str, Any]]:
    return [
        item
        for item in database.list_records("agent_jobs")
        if item.get("workspaceId") == workspace_id and item.get("request", {}).get("agentId") == agent_id
    ]


def test_kill_switch_cancels_every_matching_job_beyond_ui_page_size(secure_client: TestClient) -> None:
    workspace_id = "bulk-kill"
    owner, registration = register_agent(secure_client, workspace_id)
    identity_id = registration["identity"]["id"]
    for index in range(30):
        save_job(workspace_id, f"kill-job-{index:02d}", identity_id)

    response = secure_client.post(
        f"/api/agent-control/identities/{identity_id}/kill-switch",
        headers=owner,
        json={"reason": "Emergency bulk containment"},
    )

    assert response.status_code == 200
    assert response.json()["cancelledJobs"] == 30
    assert {job["status"] for job in matching_jobs(workspace_id, identity_id)} == {"cancelled"}


def test_production_revoke_cancels_every_matching_production_job(secure_client: TestClient) -> None:
    workspace_id = "bulk-prod-revoke"
    owner, registration = register_agent(secure_client, workspace_id)
    identity_id = registration["identity"]["id"]
    access = secure_client.post(
        "/api/agent-control/production-access",
        headers=owner,
        json={
            "agentId": identity_id,
            "targetEnvironment": "prod",
            "justification": "Required for production lifecycle verification",
        },
    ).json()
    approver_email = "second-owner@example.com"
    database.save_record(
        "workspace_members",
        f"{workspace_id}:second-owner",
        {
            "id": "second-owner",
            "workspaceId": workspace_id,
            "name": "Second owner",
            "email": approver_email,
            "role": "Owner",
            "access": "All Workspace",
            "createdAt": "2026-07-16T09:00:00",
            "updatedAt": "2026-07-16T09:00:00",
        },
    )
    approver = auth_header(approver_email, workspace_id)
    approved = secure_client.post(
        f"/api/agent-control/production-access/{access['id']}/approve",
        headers={**approver, "Idempotency-Key": "bulk-production-approve"},
        json={"reason": "Production approved", "evidenceHash": f"sha256:{'a' * 64}"},
    )
    assert approved.status_code == 200
    for index in range(30):
        save_job(workspace_id, f"prod-job-{index:02d}", identity_id, environment="prod")

    revoked = secure_client.post(
        f"/api/agent-control/production-access/{access['id']}/revoke",
        headers={**approver, "Idempotency-Key": "bulk-production-revoke"},
        json={"reason": "Production access withdrawn", "evidenceHash": f"sha256:{'b' * 64}"},
    )

    assert revoked.status_code == 200
    assert {job["status"] for job in matching_jobs(workspace_id, identity_id)} == {"cancelled"}


@pytest.mark.parametrize(
    ("identity_status", "production_status", "environment"),
    [
        ("disabled", "not_requested", "staging"),
        ("revoked", "not_requested", "staging"),
        ("active", "revoked", "prod"),
    ],
)
def test_worker_revalidates_identity_lifecycle_before_execution(
    secure_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    identity_status: str,
    production_status: str,
    environment: str,
) -> None:
    workspace_id = f"worker-{identity_status}-{environment}"
    owner, registration = register_agent(secure_client, workspace_id)
    identity_id = registration["identity"]["id"]
    record_id = f"{workspace_id}:{identity_id}"
    identity = database.get_record("agent_identities", record_id)
    assert identity is not None
    identity.update(status=identity_status, productionAccessStatus=production_status)
    database.save_record("agent_identities", record_id, identity)
    save_job(workspace_id, "lifecycle-job", identity_id, environment=environment)

    def forbidden_run(_request: Any) -> Any:
        raise AssertionError("run_agent must not execute after authority is revoked")

    monkeypatch.setattr(job_queue, "run_agent", forbidden_run)
    response = secure_client.post(
        "/api/agent-runtime/jobs/lifecycle-job/process",
        headers=owner,
    )

    assert response.status_code == 200
    assert response.json()["job"]["status"] == "blocked"
    assert "input" not in str(response.json()["job"].get("error", "")).lower()


def test_worker_paused_before_claim_cannot_execute_after_kill_switch_commits(
    secure_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace_id = "claim-kill-boundary"
    owner, registration = register_agent(secure_client, workspace_id)
    identity_id = registration["identity"]["id"]
    content_hash = f"sha256:{'a' * 64}"
    context_hash = f"sha256:{'b' * 64}"
    save_active_lease(workspace_id, "boundary-lease", identity_id, content_hash, context_hash)
    save_job(workspace_id, "boundary-job", identity_id, lease_id="boundary-lease", context_hash=context_hash)
    worker_ready = Event()
    resume_worker = Event()
    original_record = job_queue._job_record
    original_run = job_queue.run_agent

    def pause_worker_lookup(selected_workspace: str, job_id: str):
        record = original_record(selected_workspace, job_id)
        if not worker_ready.is_set():
            worker_ready.set()
            assert resume_worker.wait(timeout=5)
        return record

    executed = Event()

    def track_run(request: Any):
        executed.set()
        return original_run(request)

    monkeypatch.setattr(job_queue, "_job_record", pause_worker_lookup)
    monkeypatch.setattr(job_queue, "run_agent", track_run)

    def process() -> Any:
        return secure_client.post(
            "/api/agent-runtime/jobs/boundary-job/process",
            headers=owner,
        )

    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(process)
        assert worker_ready.wait(timeout=5)
        stopped = secure_client.post(
            f"/api/agent-control/identities/{identity_id}/kill-switch",
            headers=owner,
            json={"reason": "Revoked before worker claim"},
        )
        assert stopped.status_code == 200
        resume_worker.set()
        processed = future.result(timeout=5)

    assert not executed.is_set()
    assert processed.status_code in {200, 409}
    if processed.status_code == 200:
        assert processed.json()["job"]["status"] in {"blocked", "cancelled"}


def test_concurrent_workers_claim_once_and_execute_once(
    secure_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace_id = "single-worker-claim"
    owner, registration = register_agent(secure_client, workspace_id)
    identity_id = registration["identity"]["id"]
    content_hash = f"sha256:{'a' * 64}"
    context_hash = f"sha256:{'c' * 64}"
    save_active_lease(workspace_id, "single-lease", identity_id, content_hash, context_hash)
    save_job(workspace_id, "single-job", identity_id, lease_id="single-lease", context_hash=context_hash)
    original_run = job_queue.run_agent
    call_count = 0
    call_lock = __import__("threading").Lock()

    def counted_run(request: Any):
        nonlocal call_count
        with call_lock:
            call_count += 1
        return original_run(request)

    monkeypatch.setattr(job_queue, "run_agent", counted_run)
    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(executor.map(
            lambda _: secure_client.post("/api/agent-runtime/jobs/single-job/process", headers=owner),
            range(2),
        ))

    assert all(response.status_code == 200 for response in responses)
    assert call_count == 1


def test_identity_execution_guard_releases_unused_lock_entries() -> None:
    baseline = len(job_queue._identity_locks)

    for index in range(100):
        workspace_id = f"lock-cleanup-workspace-{index}"
        identity_id = f"lock-cleanup-identity-{index}"
        key = (workspace_id, identity_id)

        with job_queue.identity_execution_guard(workspace_id, {identity_id}):
            assert key in job_queue._identity_locks

    assert len(job_queue._identity_locks) == baseline
