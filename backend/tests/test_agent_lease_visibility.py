from collections.abc import Generator
import json
import os
from pathlib import Path
from typing import Any

import jwt
from fastapi.testclient import TestClient
import pytest

from app import database
from app.main import app


TEST_JWT_SECRET = "lease-visibility-test-secret-32-bytes"


def lease_payload(
    lease_id: str,
    workspace_id: str,
    created_at: str,
    **overrides: Any,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": lease_id,
        "identityId": f"identity-{workspace_id}",
        "action": "metadata_read",
        "toolCategory": "metadata",
        "operation": "inspect_run_metadata",
        "contextHash": f"sha256:{'a' * 64}",
        "contentHash": f"sha256:{'b' * 64}",
        "provider": "openai",
        "environment": "staging",
        "risk": "low",
        "status": "active",
        "idempotencyKey": f"idem-{lease_id}",
        "approvalId": None,
        "createdAt": created_at,
        "expiresAt": "2027-07-16T10:10:00",
        "workspaceId": workspace_id,
    }
    payload.update(overrides)
    return payload


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


def add_member(workspace_id: str, email: str, role: str) -> None:
    database.save_record(
        "workspace_members",
        f"member-{workspace_id}-{role.lower()}",
        {
            "id": f"member-{workspace_id}-{role.lower()}",
            "workspaceId": workspace_id,
            "name": role,
            "email": email,
            "role": role,
            "access": "Read Only" if role == "Viewer" else "All Workspace",
            "createdAt": "2026-07-16T09:00:00",
            "updatedAt": "2026-07-16T09:00:00",
        },
    )


@pytest.fixture()
def client(tmp_path: Path) -> Generator[TestClient]:
    database.DB_PATH = tmp_path / "lease-visibility.sqlite3"
    database.POSTGRES_URL = None
    os.environ["NEURALOPS_DB_PATH"] = str(database.DB_PATH)
    os.environ.pop("NEURALOPS_DATABASE_URL", None)
    os.environ.pop("SUPABASE_DB_URL", None)
    os.environ.pop("DATABASE_URL", None)
    os.environ.pop("NEURALOPS_AUTH_REQUIRED", None)
    with TestClient(app) as test_client:
        yield test_client


def test_lease_list_is_newest_first_and_strips_untyped_sensitive_fields(client: TestClient) -> None:
    database.save_record(
        "agent_authorization_leases",
        "lease-older",
        lease_payload(
            "lease-older",
            "local-workspace",
            "2026-07-16T09:00:00",
            credentialHash="must-not-leak",
            rawPrompt="confidential customer prompt",
            toolArguments={"command": "echo secret"},
        ),
    )
    database.save_record(
        "agent_authorization_leases",
        "lease-newer",
        lease_payload("lease-newer", "local-workspace", "2026-07-16T10:00:00"),
    )

    response = client.get("/api/agent-control/leases")

    assert response.status_code == 200
    assert [lease["id"] for lease in response.json()] == ["lease-newer", "lease-older"]
    serialized = json.dumps(response.json())
    assert "credentialHash" not in serialized
    assert "must-not-leak" not in serialized
    assert "confidential customer prompt" not in serialized
    assert "echo secret" not in serialized
    assert "workspaceId" not in response.json()[0]
    assert response.json()[0]["contentHash"].startswith("sha256:")


def test_lease_list_is_workspace_scoped_and_requires_authentication(tmp_path: Path) -> None:
    database.DB_PATH = tmp_path / "lease-tenant-isolation.sqlite3"
    database.POSTGRES_URL = None
    os.environ["NEURALOPS_DB_PATH"] = str(database.DB_PATH)
    os.environ["NEURALOPS_AUTH_REQUIRED"] = "true"
    os.environ["SUPABASE_JWT_SECRET"] = TEST_JWT_SECRET
    try:
        with TestClient(app) as test_client:
            database.save_record(
                "agent_authorization_leases",
                "workspace-a:lease-a",
                lease_payload("lease-a", "workspace-a", "2026-07-16T09:00:00"),
            )
            database.save_record(
                "agent_authorization_leases",
                "workspace-b:lease-b",
                lease_payload("lease-b", "workspace-b", "2026-07-16T10:00:00"),
            )

            assert test_client.get("/api/agent-control/leases").status_code == 401
            workspace_a = test_client.get(
                "/api/agent-control/leases",
                headers=auth_header("owner-a@example.com", "workspace-a"),
            )
            workspace_b = test_client.get(
                "/api/agent-control/leases",
                headers=auth_header("owner-b@example.com", "workspace-b"),
            )

            assert workspace_a.status_code == 200
            assert [lease["id"] for lease in workspace_a.json()] == ["lease-a"]
            assert workspace_b.status_code == 200
            assert [lease["id"] for lease in workspace_b.json()] == ["lease-b"]
    finally:
        os.environ.pop("NEURALOPS_AUTH_REQUIRED", None)
        os.environ.pop("SUPABASE_JWT_SECRET", None)


def test_workspace_viewer_can_read_leases_but_agent_credential_cannot_use_operator_route(
    tmp_path: Path,
) -> None:
    database.DB_PATH = tmp_path / "lease-rbac.sqlite3"
    database.POSTGRES_URL = None
    os.environ["NEURALOPS_DB_PATH"] = str(database.DB_PATH)
    os.environ["NEURALOPS_AUTH_REQUIRED"] = "true"
    os.environ["SUPABASE_JWT_SECRET"] = TEST_JWT_SECRET
    try:
        with TestClient(app) as test_client:
            workspace_id = "viewer-workspace"
            viewer_email = "viewer@example.com"
            add_member(workspace_id, viewer_email, "Viewer")
            database.save_record(
                "agent_authorization_leases",
                f"{workspace_id}:lease-viewer",
                lease_payload("lease-viewer", workspace_id, "2026-07-16T09:00:00"),
            )

            viewer = test_client.get(
                "/api/agent-control/leases",
                headers=auth_header(viewer_email, workspace_id),
            )
            agent_credential = test_client.get(
                "/api/agent-control/leases",
                headers={"x-neuralops-agent-key": "nop_agent_not_a_human_session"},
            )

            assert viewer.status_code == 200
            assert viewer.json()[0]["id"] == "lease-viewer"
            assert agent_credential.status_code == 401
    finally:
        os.environ.pop("NEURALOPS_AUTH_REQUIRED", None)
        os.environ.pop("SUPABASE_JWT_SECRET", None)
