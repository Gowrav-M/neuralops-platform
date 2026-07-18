from collections.abc import Generator
import json
import os
from pathlib import Path
from typing import Any

import jwt
import pytest
from fastapi.testclient import TestClient

from app import database
from app.main import app


TEST_JWT_SECRET = "agent-job-tenant-test-secret-32-bytes"


def auth_header(email: str, workspace_id: str) -> dict[str, str]:
    token = jwt.encode(
        {
            "sub": email,
            "email": email,
            "role": "authenticated",
            "app_metadata": {"neuralops_workspace_id": workspace_id},
        },
        TEST_JWT_SECRET,
        algorithm="HS256",
    )
    return {"Authorization": f"Bearer {token}"}


def job_payload(
    job_id: str,
    workspace_id: str | None,
    *,
    agent_id: str = "support_triage",
    status: str = "queued",
    secret: str = "tenant-private job input",
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": job_id,
        "status": status,
        "request": {
            "agentId": agent_id,
            "input": secret,
            "providerMode": "local",
            "environment": "staging",
        },
        "attempts": 0,
        "maxAttempts": 2,
        "createdAt": "2026-07-16T09:00:00+00:00",
        "updatedAt": "2026-07-16T09:00:00+00:00",
    }
    if workspace_id is not None:
        payload["workspaceId"] = workspace_id
    return payload


def add_member(workspace_id: str, email: str, role: str = "Viewer") -> None:
    database.save_record(
        "workspace_members",
        f"member-{workspace_id}-{email}",
        {
            "id": f"member-{workspace_id}-{email}",
            "workspaceId": workspace_id,
            "name": email,
            "email": email,
            "role": role,
            "access": "Read Only" if role == "Viewer" else "All Workspace",
            "createdAt": "2026-07-16T09:00:00",
            "updatedAt": "2026-07-16T09:00:00",
        },
    )


@pytest.fixture()
def secure_client(tmp_path: Path) -> Generator[TestClient]:
    database.DB_PATH = tmp_path / "agent-job-tenants.sqlite3"
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


def test_job_list_detail_and_summary_are_workspace_scoped(secure_client: TestClient) -> None:
    database.save_record("agent_jobs", "job-a", job_payload("job-a", "workspace-a", secret="workspace-a input"))
    database.save_record("agent_jobs", "job-b", job_payload("job-b", "workspace-b", secret="workspace-b secret"))
    headers = auth_header("owner-a@example.com", "workspace-a")

    listed = secure_client.get("/api/agent-runtime/jobs", headers=headers)
    detail = secure_client.get("/api/agent-runtime/jobs/job-b", headers=headers)
    summary = secure_client.get("/api/agent-runtime/jobs/summary", headers=headers)

    assert listed.status_code == 200
    assert [job["id"] for job in listed.json()] == ["job-a"]
    assert "workspace-b secret" not in json.dumps(listed.json())
    assert detail.status_code == 404
    assert summary.status_code == 200
    assert summary.json()["total"] == 1
    assert summary.json()["queued"] == 1


@pytest.mark.parametrize("action", ["process", "retry", "cancel"])
def test_cross_workspace_job_mutations_fail_closed(
    secure_client: TestClient,
    action: str,
) -> None:
    initial_status = "failed" if action == "retry" else "queued"
    database.save_record(
        "agent_jobs",
        f"job-b-{action}",
        job_payload(f"job-b-{action}", "workspace-b", status=initial_status),
    )
    before = database.get_record("agent_jobs", f"job-b-{action}")

    response = secure_client.post(
        f"/api/agent-runtime/jobs/job-b-{action}/{action}",
        headers=auth_header("owner-a@example.com", "workspace-a"),
    )

    assert response.status_code == 404
    assert database.get_record("agent_jobs", f"job-b-{action}") == before


def test_process_next_does_not_claim_another_workspace_job(secure_client: TestClient) -> None:
    database.save_record(
        "agent_jobs",
        "job-b-next",
        job_payload("job-b-next", "workspace-b"),
    )
    before = database.get_record("agent_jobs", "job-b-next")

    response = secure_client.post(
        "/api/agent-runtime/jobs/process-next",
        headers=auth_header("owner-a@example.com", "workspace-a"),
    )

    assert response.status_code == 404
    assert database.get_record("agent_jobs", "job-b-next") == before


def test_kill_switch_cancels_only_jobs_bound_to_its_workspace(secure_client: TestClient) -> None:
    owner = auth_header("owner-a@example.com", "workspace-a")
    assert secure_client.get("/api/workspace", headers=owner).status_code == 200
    registration = secure_client.post(
        "/api/agent-control/identities",
        headers=owner,
        json={
            "displayName": "Shared alias agent",
            "owner": "owner-a@example.com",
            "environment": "staging",
            "permissions": ["metadata:read"],
            "providerAccess": ["local"],
        },
    )
    assert registration.status_code == 200
    identity_id = registration.json()["identity"]["id"]
    database.save_record(
        "agent_jobs",
        "workspace-b-job-with-shared-alias",
        job_payload(
            "workspace-b-job-with-shared-alias",
            "workspace-b",
            agent_id=identity_id,
        ),
    )

    stopped = secure_client.post(
        f"/api/agent-control/identities/{identity_id}/kill-switch",
        headers=owner,
        json={"reason": "Contain workspace A only"},
    )

    assert stopped.status_code == 200
    assert stopped.json()["cancelledJobs"] == 0
    stored = database.get_record("agent_jobs", "workspace-b-job-with-shared-alias")
    assert stored is not None and stored["status"] == "queued"


def test_legacy_unbound_jobs_are_invisible_and_immutable(secure_client: TestClient) -> None:
    database.save_record("agent_jobs", "legacy-job", job_payload("legacy-job", None, secret="legacy raw secret"))
    headers = auth_header("owner-a@example.com", "workspace-a")

    listed = secure_client.get("/api/agent-runtime/jobs", headers=headers)
    detail = secure_client.get("/api/agent-runtime/jobs/legacy-job", headers=headers)
    process = secure_client.post("/api/agent-runtime/jobs/legacy-job/process", headers=headers)
    retry = secure_client.post("/api/agent-runtime/jobs/legacy-job/retry", headers=headers)
    cancel = secure_client.post("/api/agent-runtime/jobs/legacy-job/cancel", headers=headers)

    assert listed.status_code == 200
    assert listed.json() == []
    assert "legacy raw secret" not in json.dumps(listed.json())
    assert {detail.status_code, process.status_code, retry.status_code, cancel.status_code} == {404}
    stored = database.get_record("agent_jobs", "legacy-job")
    assert stored is not None and stored["status"] == "queued"


def test_job_read_routes_require_workspace_read_and_allow_viewer(secure_client: TestClient) -> None:
    workspace_id = "viewer-workspace"
    viewer_email = "viewer@example.com"
    add_member(workspace_id, viewer_email, "Viewer")
    database.save_record(
        "agent_jobs",
        "viewer-job",
        job_payload("viewer-job", workspace_id, secret="viewer workspace input"),
    )

    assert secure_client.get("/api/agent-runtime/jobs").status_code == 401
    viewer = secure_client.get(
        "/api/agent-runtime/jobs",
        headers=auth_header(viewer_email, workspace_id),
    )
    denied_mutation = secure_client.post(
        "/api/agent-runtime/jobs/viewer-job/cancel",
        headers=auth_header(viewer_email, workspace_id),
    )

    assert viewer.status_code == 200
    assert [job["id"] for job in viewer.json()] == ["viewer-job"]
    assert denied_mutation.status_code == 403
