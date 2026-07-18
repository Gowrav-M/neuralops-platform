from __future__ import annotations

from collections.abc import Generator
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
import json
import os
from pathlib import Path
import sqlite3
from threading import Barrier, Event, Lock, get_ident
from typing import Any

import jwt
import pytest
from fastapi.testclient import TestClient

from app import database
import app.main as main_module
from app.main import app


def digest(value: str) -> str:
    return f"sha256:{sha256(value.encode('utf-8')).hexdigest()}"


def auth_header(email: str, workspace_id: str) -> dict[str, str]:
    token = jwt.encode(
        {
            "sub": email,
            "email": email,
            "role": "authenticated",
            "app_metadata": {"neuralops_workspace_id": workspace_id},
        },
        "test-jwt-secret",
        algorithm="HS256",
    )
    return {"authorization": f"Bearer {token}"}


def add_workspace_member(workspace_id: str, email: str, role: str = "Owner") -> dict[str, str]:
    member_id = f"member-{sha256(f'{workspace_id}:{email}'.encode('utf-8')).hexdigest()[:12]}"
    database.save_record(
        "workspace_members",
        member_id,
        {
            "id": member_id,
            "workspaceId": workspace_id,
            "name": email.split("@", 1)[0],
            "email": email,
            "role": role,
            "access": "All Workspace" if role == "Owner" else "Security and Audit",
            "createdAt": "2026-07-13T00:00:00",
            "updatedAt": "2026-07-13T00:00:00",
        },
    )
    return auth_header(email, workspace_id)


@pytest.fixture()
def secure_client(tmp_path: Path) -> Generator[TestClient]:
    database.DB_PATH = tmp_path / "neuralops-agent-security.sqlite3"
    database.POSTGRES_URL = None
    os.environ["NEURALOPS_DB_PATH"] = str(database.DB_PATH)
    os.environ["NEURALOPS_AUTH_REQUIRED"] = "true"
    os.environ["SUPABASE_JWT_SECRET"] = "test-jwt-secret"
    try:
        with TestClient(app) as client:
            yield client
    finally:
        os.environ.pop("NEURALOPS_AUTH_REQUIRED", None)
        os.environ.pop("SUPABASE_JWT_SECRET", None)


def register(
    client: TestClient,
    workspace_id: str,
    *,
    name: str = "Runtime agent",
    providers: list[str] | None = None,
    permissions: list[str] | None = None,
) -> dict[str, Any]:
    owner = auth_header(f"owner-{workspace_id}@example.com", workspace_id)
    assert client.get("/api/workspace", headers=owner).status_code == 200
    response = client.post(
        "/api/agent-control/identities",
        headers=owner,
        json={
            "displayName": name,
            "owner": f"owner-{workspace_id}@example.com",
            "environment": "all",
            "providerAccess": providers or ["openai"],
            "permissions": permissions or ["metadata:read"],
        },
    )
    assert response.status_code == 200
    return response.json()


def authorization_body(identity_id: str, *, key: str = "metadata-1") -> dict[str, Any]:
    return {
        "identityId": identity_id,
        "action": "metadata_read",
        "toolCategory": "metadata",
        "operation": "inspect_run_metadata",
        "contextHash": digest("workspace/run/42"),
        "contentHash": digest("metadata fields only"),
        "provider": "openai",
        "environment": "staging",
        "idempotencyKey": key,
    }


def governed_runtime_payload(
    client: TestClient,
    payload: dict[str, Any],
    *,
    key: str,
) -> dict[str, Any]:
    agent_id = str(payload["agentId"])
    environment = str(payload.get("environment", "staging"))
    provider = str(payload.get("provider") or "local")
    model = str(payload.get("model") or "local-neuralops-agent")
    identity = client.get(f"/api/agent-control/identities/{agent_id}").json()
    updated = client.patch(
        f"/api/agent-control/identities/{identity['id']}",
        json={
            "environment": "all",
            "providerAccess": sorted(set(identity.get("providerAccess", [])) | {provider}),
        },
    )
    assert updated.status_code == 200
    rotated = client.post(f"/api/agent-control/identities/{identity['id']}/rotate")
    assert rotated.status_code == 200
    agent_headers = {"x-neuralops-agent-key": rotated.json()["credential"]}
    context_hash = digest(f"{key}:context")
    authorization = {
        "identityId": identity["id"],
        "action": "agent_run",
        "toolCategory": "agent_runtime",
        "operation": "execute",
        "contextHash": context_hash,
        "contentHash": digest(str(payload["input"])),
        "provider": provider,
        "model": model,
        "environment": environment,
        "idempotencyKey": f"{key}-authorize",
    }
    pending = client.post("/api/agent-control/authorize", headers=agent_headers, json=authorization)
    assert pending.status_code == 200 and pending.json()["decision"] == "review"
    approved = client.post(
        f"/api/agent-control/approvals/{pending.json()['approval']['id']}/approve",
        headers={"Idempotency-Key": f"{key}-approve"},
        json={"reason": "Approved governed privacy test", "evidenceHash": digest(key)},
    )
    assert approved.status_code == 200
    allowed = client.post("/api/agent-control/authorize", headers=agent_headers, json=authorization)
    assert allowed.status_code == 200 and allowed.json()["decision"] == "allow"
    return {
        **payload,
        "provider": provider,
        "model": model,
        "authorizationLeaseId": allowed.json()["lease"]["id"],
        "authorizationContextHash": context_hash,
    }


def test_runtime_control_paths_accept_only_credential_and_resolve_its_workspace(secure_client: TestClient) -> None:
    first = register(secure_client, "workspace-a")
    second = register(secure_client, "workspace-b")
    credential_headers = {"x-neuralops-agent-key": first["credential"]}

    authorized = secure_client.post(
        "/api/agent-control/authorize",
        headers=credential_headers,
        json=authorization_body(first["identity"]["id"]),
    )
    assert authorized.status_code == 200
    assert authorized.json()["decision"] == "allow"

    operator_route = secure_client.get("/api/agent-control/identities", headers=credential_headers)
    assert operator_route.status_code == 401

    cross_workspace = secure_client.post(
        "/api/agent-control/authorize",
        headers=credential_headers,
        json=authorization_body(second["identity"]["id"], key="cross-workspace"),
    )
    assert cross_workspace.status_code == 401
    assert cross_workspace.json() == {"detail": "Invalid agent credential"}


def test_authorization_replays_only_the_same_active_lease_after_a_lost_response(secure_client: TestClient) -> None:
    registration = register(secure_client, "lost-response")
    headers = {"x-neuralops-agent-key": registration["credential"]}
    body = authorization_body(registration["identity"]["id"], key="lost-response-key")

    first = secure_client.post("/api/agent-control/authorize", headers=headers, json=body)
    replay = secure_client.post("/api/agent-control/authorize", headers=headers, json=body)

    assert first.status_code == 200
    assert replay.status_code == 200
    assert replay.json() == first.json()
    matching = [
        lease
        for lease in database.list_records("agent_authorization_leases")
        if lease.get("idempotencyKey") == "lost-response-key"
    ]
    assert len(matching) == 1

    changed = secure_client.post(
        "/api/agent-control/authorize",
        headers=headers,
        json={**body, "contentHash": digest("different binding")},
    )
    assert changed.status_code == 409

    lease_id = first.json()["lease"]["id"]
    consumed = secure_client.post(
        "/api/agent-control/leases/consume",
        headers=headers,
        json={**body, "leaseId": lease_id},
    )
    assert consumed.status_code == 200
    assert secure_client.post("/api/agent-control/authorize", headers=headers, json=body).status_code == 409


@pytest.mark.parametrize("terminal_state", ["revoked", "expired"])
def test_authorization_does_not_replay_revoked_or_expired_leases(
    secure_client: TestClient,
    terminal_state: str,
) -> None:
    registration = register(secure_client, f"terminal-{terminal_state}")
    headers = {"x-neuralops-agent-key": registration["credential"]}
    body = authorization_body(registration["identity"]["id"], key=f"terminal-{terminal_state}-key")
    first = secure_client.post("/api/agent-control/authorize", headers=headers, json=body)
    assert first.status_code == 200
    lease = first.json()["lease"]
    record = next(
        item
        for item in database.list_domain_records_with_ids("agent_authorization_leases")
        if item["payload"]["id"] == lease["id"]
    )
    payload = record["payload"]
    if terminal_state == "expired":
        payload["expiresAt"] = "2000-01-01T00:00:00"
    else:
        payload["status"] = "revoked"
        payload["revokedAt"] = "2026-07-16T00:00:00"
    database.save_record("agent_authorization_leases", record["id"], payload)

    replay = secure_client.post("/api/agent-control/authorize", headers=headers, json=body)
    assert replay.status_code == 409


def test_agent_credential_workspace_resolution_uses_direct_database_lookup(
    secure_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    registration = register(secure_client, "credential-indexed-lookup")

    def reject_global_scan(_domain: str) -> list[dict[str, Any]]:
        raise AssertionError("credential authentication must not list all identities")

    monkeypatch.setattr(main_module, "list_records", reject_global_scan)
    response = secure_client.post(
        "/api/agent-control/authorize",
        headers={"x-neuralops-agent-key": registration["credential"]},
        json=authorization_body(registration["identity"]["id"]),
    )

    assert response.status_code == 200
    assert response.json()["decision"] == "allow"


@pytest.mark.parametrize("missing", ["operation", "contextHash", "contentHash", "provider"])
def test_authorization_requires_complete_provider_bound_hash_metadata(
    secure_client: TestClient, missing: str
) -> None:
    registration = register(secure_client, f"required-{missing}")
    body = authorization_body(registration["identity"]["id"])
    body.pop(missing)
    response = secure_client.post(
        "/api/agent-control/authorize",
        headers={"x-neuralops-agent-key": registration["credential"]},
        json=body,
    )
    assert response.status_code == 422


@pytest.mark.parametrize("field", ["contextHash", "contentHash"])
def test_authorization_rejects_non_sha256_hashes(secure_client: TestClient, field: str) -> None:
    registration = register(secure_client, f"invalid-{field}")
    body = authorization_body(registration["identity"]["id"])
    body[field] = "sha256:not-a-digest"
    response = secure_client.post(
        "/api/agent-control/authorize",
        headers={"x-neuralops-agent-key": registration["credential"]},
        json=body,
    )
    assert response.status_code == 422


def test_authorization_persists_bounded_metadata_and_rejects_content_capture(secure_client: TestClient) -> None:
    registration = register(secure_client, "telemetry")
    body = {
        **authorization_body(registration["identity"]["id"]),
        "model": "gpt-5-mini",
        "timingMs": 42,
        "tokens": 120,
        "costUsd": 0.004,
        "status": "success",
        "policyFindings": ["pii-redacted"],
    }
    response = secure_client.post(
        "/api/agent-control/authorize",
        headers={"x-neuralops-agent-key": registration["credential"]},
        json=body,
    )
    assert response.status_code == 200
    stored = database.list_records("agent_authorization_leases")
    assert stored[0]["model"] == "gpt-5-mini"
    assert stored[0]["tokens"] == 120
    assert "arguments" not in stored[0]

    raw_capture = secure_client.post(
        "/api/agent-control/authorize",
        headers={"x-neuralops-agent-key": registration["credential"]},
        json={**body, "idempotencyKey": "raw-content", "arguments": {"secret": "do-not-store"}},
    )
    assert raw_capture.status_code == 422
    encrypted_mode = secure_client.post(
        "/api/agent-control/identities",
        headers=auth_header("owner-telemetry@example.com", "telemetry"),
        json={"displayName": "Unsafe capture", "owner": "owner@example.com", "captureMode": "encrypted_content"},
    )
    assert encrypted_mode.status_code == 422


def test_lease_validate_and_consume_are_bound_expiring_and_single_use(secure_client: TestClient) -> None:
    registration = register(secure_client, "leases")
    body = authorization_body(registration["identity"]["id"])
    headers = {"x-neuralops-agent-key": registration["credential"]}
    lease = secure_client.post("/api/agent-control/authorize", headers=headers, json=body).json()["lease"]
    binding = {**body, "leaseId": lease["id"]}

    assert secure_client.post("/api/agent-control/leases/validate", headers=headers, json=binding).status_code == 200
    mutated = {**binding, "contextHash": digest("different context")}
    assert secure_client.post("/api/agent-control/leases/validate", headers=headers, json=mutated).status_code == 409
    consumed = secure_client.post("/api/agent-control/leases/consume", headers=headers, json=binding)
    assert consumed.status_code == 200
    assert consumed.json()["status"] == "consumed"
    assert secure_client.post("/api/agent-control/leases/consume", headers=headers, json=binding).status_code == 409

    another = secure_client.post(
        "/api/agent-control/authorize",
        headers=headers,
        json={**body, "idempotencyKey": "expiring-lease"},
    ).json()["lease"]
    record = next(item for item in database.list_domain_records_with_ids("agent_authorization_leases") if item["payload"]["id"] == another["id"])
    payload = record["payload"]
    payload["expiresAt"] = "2000-01-01T00:00:00"
    database.save_record("agent_authorization_leases", record["id"], payload)
    expired_binding = {**body, "idempotencyKey": "expiring-lease", "leaseId": another["id"]}
    assert secure_client.post("/api/agent-control/leases/consume", headers=headers, json=expired_binding).status_code == 409


def test_staging_access_request_cannot_approve_production(secure_client: TestClient) -> None:
    registration = register(secure_client, "environment-isolation")
    owner = auth_header("owner-environment-isolation@example.com", "environment-isolation")
    request = secure_client.post(
        "/api/agent-control/production-access",
        headers=owner,
        json={
            "agentId": registration["identity"]["id"],
            "targetEnvironment": "staging",
            "justification": "Staging pilot access only",
        },
    )
    assert request.status_code == 422


def test_builtin_alias_production_access_decision_updates_canonical_identity(tmp_path: Path) -> None:
    database.DB_PATH = tmp_path / "neuralops-builtin-access-alias.sqlite3"
    database.POSTGRES_URL = None
    os.environ["NEURALOPS_DB_PATH"] = str(database.DB_PATH)
    os.environ.pop("NEURALOPS_AUTH_REQUIRED", None)
    with TestClient(app) as client:
        requested = client.post(
            "/api/agent-control/production-access",
            json={
                "agentId": "support_triage",
                "targetEnvironment": "prod",
                "justification": "Enable the governed built-in agent for the production pilot",
            },
        )
        assert requested.status_code == 200

        approved = client.post(
            f"/api/agent-control/production-access/{requested.json()['id']}/approve",
            headers={"Idempotency-Key": "builtin-production-approve"},
            json={"reason": "Pilot owner approved", "evidenceHash": digest("built-in production")},
        )

        assert approved.status_code == 200
        assert approved.json()["agentId"] == "support_triage"
        canonical = database.get_record("agent_identities", "agent_identity_support_triage")
        assert canonical is not None
        assert canonical["productionAccessStatus"] == "approved"


def test_newer_production_access_decision_supersedes_stale_pending_sibling(tmp_path: Path) -> None:
    database.DB_PATH = tmp_path / "neuralops-current-production-access.sqlite3"
    database.POSTGRES_URL = None
    os.environ["NEURALOPS_DB_PATH"] = str(database.DB_PATH)
    os.environ.pop("NEURALOPS_AUTH_REQUIRED", None)
    with TestClient(app) as client:
        identity = client.get("/api/agent-control/identities/support_triage").json()
        request_body = {
            "agentId": identity["id"],
            "targetEnvironment": "prod",
            "justification": "Request governed production access for the invited pilot",
        }
        stale = client.post("/api/agent-control/production-access", json=request_body).json()
        current = client.post("/api/agent-control/production-access", json=request_body).json()

        blocked = client.post(
            f"/api/agent-control/production-access/{current['id']}/block",
            headers={"Idempotency-Key": "current-production-block"},
            json={"reason": "Security review blocked current request", "evidenceHash": digest("current block")},
        )
        assert blocked.status_code == 200

        stale_approval = client.post(
            f"/api/agent-control/production-access/{stale['id']}/approve",
            headers={"Idempotency-Key": "stale-production-approve"},
            json={"reason": "Stale owner approval", "evidenceHash": digest("stale approval")},
        )
        assert stale_approval.status_code == 409
        assert client.get(f"/api/agent-control/identities/{identity['id']}").json()["productionAccessStatus"] == "blocked"
        stored_stale = database.get_record("agent_access_requests", stale["id"])
        assert stored_stale is not None
        assert stored_stale["status"] == "revoked"


def test_concurrent_production_access_requests_leave_only_the_newest_pending(
    secure_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace_id = "production-request-race"
    registration = register(secure_client, workspace_id)
    identity_id = registration["identity"]["id"]
    owner = auth_header(f"owner-{workspace_id}@example.com", workspace_id)
    barrier = Barrier(2)
    original_mutation = main_module.mutate_current_agent_identity

    def synchronized_mutation(*args: Any, **kwargs: Any) -> tuple[dict[str, Any] | None, int]:
        result = original_mutation(*args, **kwargs)
        if kwargs.get("lifecycle_action") == "production_request":
            barrier.wait(timeout=5)
        return result

    monkeypatch.setattr(main_module, "mutate_current_agent_identity", synchronized_mutation)
    body = {
        "agentId": identity_id,
        "targetEnvironment": "prod",
        "justification": "Concurrent governed production request",
    }
    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(
            executor.map(
                lambda _: secure_client.post(
                    "/api/agent-control/production-access", headers=owner, json=body
                ),
                range(2),
            )
        )

    assert [response.status_code for response in responses] == [200, 200]
    stored = [
        item
        for item in database.list_records("agent_access_requests")
        if item.get("workspaceId") == workspace_id and item.get("agentId") == identity_id
    ]
    assert len(stored) == 2
    assert sum(item["status"] == "pending_review" for item in stored) == 1
    assert sum(item["status"] == "revoked" for item in stored) == 1


def test_production_access_request_insert_failure_rolls_back_identity_and_prod_leases(
    secure_client: TestClient,
) -> None:
    workspace_id = "production-request-rollback"
    registration = register(secure_client, workspace_id)
    identity_id = registration["identity"]["id"]
    identity_record_id = f"{workspace_id}:{identity_id}"
    identity = database.get_record("agent_identities", identity_record_id)
    assert identity is not None
    identity["productionAccessStatus"] = "approved"
    database.save_record("agent_identities", identity_record_id, identity)
    lease_id = "agent_lease_before_failed_access_request"
    database.save_record(
        "agent_authorization_leases",
        f"{workspace_id}:{lease_id}",
        {
            "id": lease_id,
            "workspaceId": workspace_id,
            "identityId": identity_id,
            "environment": "prod",
            "status": "active",
        },
    )
    with database.connect() as conn:
        conn.execute(
            """
            CREATE TRIGGER abort_agent_access_request_insert
            BEFORE INSERT ON records
            WHEN NEW.domain = 'agent_access_requests'
            BEGIN
              SELECT RAISE(ABORT, 'forced access request insert failure');
            END
            """
        )

    with pytest.raises(sqlite3.IntegrityError, match="forced access request insert failure"):
        secure_client.post(
            "/api/agent-control/production-access",
            headers=auth_header(f"owner-{workspace_id}@example.com", workspace_id),
            json={
                "agentId": identity_id,
                "targetEnvironment": "prod",
                "justification": "Verify transaction rollback on storage failure",
            },
        )

    stored_identity = database.get_record("agent_identities", identity_record_id)
    stored_lease = database.get_record(
        "agent_authorization_leases", f"{workspace_id}:{lease_id}"
    )
    assert stored_identity is not None and stored_lease is not None
    assert stored_identity["productionAccessStatus"] == "approved"
    assert stored_lease["status"] == "active"
    assert not [
        item
        for item in database.list_records("agent_access_requests")
        if item.get("workspaceId") == workspace_id
    ]
def test_builtin_production_runtime_requires_and_consumes_bound_lease(tmp_path: Path) -> None:
    database.DB_PATH = tmp_path / "neuralops-built-in-gate.sqlite3"
    database.POSTGRES_URL = None
    os.environ["NEURALOPS_DB_PATH"] = str(database.DB_PATH)
    os.environ.pop("NEURALOPS_AUTH_REQUIRED", None)
    with TestClient(app) as client:
        identity = client.get("/api/agent-control/identities/support_triage").json()
        client.patch(
            f"/api/agent-control/identities/{identity['id']}",
            json={"environment": "all"},
        )
        access = client.post(
            "/api/agent-control/production-access",
            json={"agentId": identity["id"], "targetEnvironment": "prod", "justification": "Production pilot runtime"},
        ).json()
        assert client.post(
            f"/api/agent-control/production-access/{access['id']}/approve",
            headers={"Idempotency-Key": "runtime-production-approve"},
            json={"reason": "Approved pilot", "evidenceHash": digest("prod evidence")},
        ).status_code == 200
        denied = client.post(
            "/api/agent-runtime/run",
            json={"agentId": "support_triage", "input": "Summarize ordinary ticket", "environment": "prod"},
        )
        assert denied.status_code == 403
        denied_job = client.post(
            "/api/agent-runtime/jobs",
            json={"agentId": "support_triage", "input": "Summarize ordinary ticket", "environment": "prod"},
        )
        assert denied_job.status_code == 422

        rotated = client.post(f"/api/agent-control/identities/{identity['id']}/rotate")
        assert rotated.status_code == 200
        credential = rotated.json()["credential"]
        authorization = {
            "identityId": identity["id"],
            "action": "agent_run",
            "toolCategory": "agent_runtime",
            "operation": "execute",
            "contextHash": digest("prod ticket run"),
            "contentHash": digest("Summarize ordinary ticket"),
            "provider": "local",
            "model": "gpt-4o-mini",
            "environment": "prod",
            "idempotencyKey": "builtin-prod-run",
        }
        pending = client.post(
            "/api/agent-control/authorize",
            headers={"x-neuralops-agent-key": credential},
            json=authorization,
        ).json()
        assert pending["decision"] == "review"
        assert client.post(
            f"/api/agent-control/approvals/{pending['approval']['id']}/approve",
            headers={"Idempotency-Key": "builtin-runtime-approve"},
            json={"reason": "Approved built-in run", "evidenceHash": digest("run evidence")},
        ).status_code == 200
        lease = client.post(
            "/api/agent-control/authorize",
            headers={"x-neuralops-agent-key": credential},
            json=authorization,
        ).json()["lease"]
        ambiguous_provider = client.post(
            "/api/agent-runtime/run",
            json={
                "agentId": "support_triage",
                "input": "Summarize ordinary ticket",
                "providerMode": "auto",
                "provider": "local",
                "model": "gpt-4o-mini",
                "environment": "prod",
                "authorizationLeaseId": lease["id"],
                "authorizationContextHash": authorization["contextHash"],
            },
        )
        assert ambiguous_provider.status_code == 422
        mismatched_provider = client.post(
            "/api/agent-runtime/run",
            json={
                "agentId": "support_triage",
                "input": "Summarize ordinary ticket",
                "providerMode": "live",
                "provider": "gateway",
                "model": "gpt-4o-mini",
                "environment": "prod",
                "authorizationLeaseId": lease["id"],
                "authorizationContextHash": authorization["contextHash"],
            },
        )
        assert mismatched_provider.status_code == 409
        mismatched_model = client.post(
            "/api/agent-runtime/run",
            json={
                "agentId": "support_triage",
                "input": "Summarize ordinary ticket",
                "providerMode": "local",
                "provider": "local",
                "model": "different-model",
                "environment": "prod",
                "authorizationLeaseId": lease["id"],
                "authorizationContextHash": authorization["contextHash"],
            },
        )
        assert mismatched_model.status_code == 409
        allowed = client.post(
            "/api/agent-runtime/run",
            json={
                "agentId": "support_triage",
                "input": "Summarize ordinary ticket",
                "providerMode": "local",
                "provider": "local",
                "model": "gpt-4o-mini",
                "environment": "prod",
                "authorizationLeaseId": lease["id"],
                "authorizationContextHash": authorization["contextHash"],
            },
        )
        assert allowed.status_code == 200
        assert allowed.json()["run"]["provider"] == "local"
        assert allowed.json()["run"]["model"] == "gpt-4o-mini"
        persisted = json.dumps(
            {
                "runs": database.list_records("agent_runs"),
                "traces": database.list_records("traces"),
            }
        )
        assert "Summarize ordinary ticket" not in persisted
        assert allowed.json()["run"]["output"] not in persisted
        assert digest("Summarize ordinary ticket") in persisted
        replay = client.post(
            "/api/agent-runtime/run",
            json={
                "agentId": "support_triage",
                "input": "Summarize ordinary ticket",
                "providerMode": "local",
                "provider": "local",
                "model": "gpt-4o-mini",
                "environment": "prod",
                "authorizationLeaseId": lease["id"],
                "authorizationContextHash": authorization["contextHash"],
            },
        )
        assert replay.status_code == 409


def test_metadata_only_production_queue_rejects_raw_input_without_consuming_lease(tmp_path: Path) -> None:
    database.DB_PATH = tmp_path / "neuralops-metadata-queue.sqlite3"
    database.POSTGRES_URL = None
    os.environ["NEURALOPS_DB_PATH"] = str(database.DB_PATH)
    os.environ.pop("NEURALOPS_AUTH_REQUIRED", None)
    with TestClient(app) as client:
        identity = client.get("/api/agent-control/identities/support_triage").json()
        client.patch(f"/api/agent-control/identities/{identity['id']}", json={"environment": "all"})
        access = client.post(
            "/api/agent-control/production-access",
            json={"agentId": identity["id"], "targetEnvironment": "prod", "justification": "Production queue privacy check"},
        ).json()
        client.post(
            f"/api/agent-control/production-access/{access['id']}/approve",
            headers={"Idempotency-Key": "queue-production-approve"},
            json={"reason": "Approved pilot", "evidenceHash": digest("queue access")},
        )
        credential = client.post(f"/api/agent-control/identities/{identity['id']}/rotate").json()["credential"]
        raw_input = "QUEUE-SECRET-DO-NOT-PERSIST"
        authorization = {
            "identityId": identity["id"],
            "action": "agent_run",
            "toolCategory": "agent_runtime",
            "operation": "execute",
            "contextHash": digest("prod queued run"),
            "contentHash": digest(raw_input),
            "provider": "local",
            "model": "gpt-4o-mini",
            "environment": "prod",
            "idempotencyKey": "metadata-only-prod-queue",
        }
        pending = client.post(
            "/api/agent-control/authorize",
            headers={"x-neuralops-agent-key": credential},
            json=authorization,
        ).json()
        client.post(
            f"/api/agent-control/approvals/{pending['approval']['id']}/approve",
            headers={"Idempotency-Key": "queue-action-approve"},
            json={"reason": "Approved queued run", "evidenceHash": digest("queue approval")},
        )
        lease = client.post(
            "/api/agent-control/authorize",
            headers={"x-neuralops-agent-key": credential},
            json=authorization,
        ).json()["lease"]

        queued = client.post(
            "/api/agent-runtime/jobs",
            json={
                "agentId": "support_triage",
                "input": raw_input,
                "providerMode": "local",
                "provider": "local",
                "model": "gpt-4o-mini",
                "environment": "prod",
                "authorizationLeaseId": lease["id"],
                "authorizationContextHash": authorization["contextHash"],
            },
        )
        assert queued.status_code == 422
        assert "metadata-only" in queued.json()["detail"].lower()
        assert raw_input not in json.dumps(database.list_records("agent_jobs"))
        stored_lease = database.get_record("agent_authorization_leases", lease["id"])
        assert stored_lease is not None and stored_lease["status"] == "active"


@pytest.mark.parametrize("environment", ["staging", "dev"])
def test_metadata_only_non_production_runs_persist_hashes_only(tmp_path: Path, environment: str) -> None:
    database.DB_PATH = tmp_path / f"neuralops-{environment}-privacy.sqlite3"
    database.POSTGRES_URL = None
    os.environ["NEURALOPS_DB_PATH"] = str(database.DB_PATH)
    os.environ.pop("NEURALOPS_AUTH_REQUIRED", None)
    raw_input = f"{environment.upper()}-INPUT-SECRET"
    with TestClient(app) as client:
        response = client.post(
            "/api/agent-runtime/run",
            json=governed_runtime_payload(
                client,
                {
                    "agentId": "support_triage",
                    "input": raw_input,
                    "providerMode": "local",
                    "provider": "local",
                    "model": "local-neuralops-agent",
                    "environment": environment,
                },
                key=f"{environment}-privacy-run",
            ),
        )
        assert response.status_code == 200
        raw_output = response.json()["run"]["output"]
        persisted = json.dumps(
            {
                "runs": database.list_records("agent_runs"),
                "traces": database.list_records("traces"),
            }
        )
        assert raw_input not in persisted
        assert raw_output not in persisted
        assert digest(raw_input) in persisted
        assert digest(raw_output) in persisted


@pytest.mark.parametrize("environment", ["staging", "dev"])
def test_metadata_only_non_production_queue_is_rejected_before_persistence(
    tmp_path: Path, environment: str
) -> None:
    database.DB_PATH = tmp_path / f"neuralops-{environment}-queue.sqlite3"
    database.POSTGRES_URL = None
    os.environ["NEURALOPS_DB_PATH"] = str(database.DB_PATH)
    os.environ.pop("NEURALOPS_AUTH_REQUIRED", None)
    raw_input = f"{environment.upper()}-QUEUE-SECRET"
    with TestClient(app) as client:
        identity = client.get("/api/agent-control/identities/support_triage").json()
        client.patch(f"/api/agent-control/identities/{identity['id']}", json={"environment": "all"})
        response = client.post(
            "/api/agent-runtime/jobs",
            json={
                "agentId": "support_triage",
                "input": raw_input,
                "providerMode": "local",
                "environment": environment,
            },
        )
        assert response.status_code == 422
        assert "metadata-only" in response.json()["detail"].lower()
        assert raw_input not in json.dumps(database.list_records("agent_jobs"))


@pytest.mark.parametrize("environment", ["staging", "dev"])
def test_metadata_only_lab_persistence_hashes_experiment_runs_and_traces(
    tmp_path: Path, environment: str
) -> None:
    database.DB_PATH = tmp_path / f"neuralops-{environment}-lab.sqlite3"
    database.POSTGRES_URL = None
    os.environ["NEURALOPS_DB_PATH"] = str(database.DB_PATH)
    os.environ.pop("NEURALOPS_AUTH_REQUIRED", None)
    raw_input = f"{environment.upper()}-LAB-SECRET"
    with TestClient(app) as client:
        governed = governed_runtime_payload(
            client,
            {
                "agentId": "support_triage",
                "input": raw_input,
                "providerMode": "local",
                "provider": "local",
                "model": "local-neuralops-agent",
                "environment": environment,
            },
            key=f"{environment}-privacy-lab",
        )
        response = client.post(
            "/api/labs/run",
            json={
                "name": f"{environment} privacy",
                "input": raw_input,
                "agentIds": ["support_triage"],
                "providerMode": "local",
                "provider": "local",
                "model": "local-neuralops-agent",
                "environment": environment,
                "authorizationLeaseIds": {"support_triage": governed["authorizationLeaseId"]},
                "authorizationContextHashes": {
                    "support_triage": governed["authorizationContextHash"]
                },
            },
        )
        assert response.status_code == 200
        raw_output = response.json()["experiment"]["variants"][0]["output"]
        persisted = json.dumps(
            {
                "experiments": database.list_records("lab_experiments"),
                "runs": database.list_records("agent_runs"),
                "traces": database.list_records("traces"),
            }
        )
        assert raw_input not in persisted
        assert raw_output not in persisted
        assert digest(raw_input) in persisted
        assert digest(raw_output) in persisted


def test_owner_can_approve_agent_principal_request_and_revoke_its_consumed_approval_lease(
    secure_client: TestClient,
) -> None:
    registration = register(
        secure_client,
        "approval-revoke",
        providers=["openai"],
        permissions=["shell:execute"],
    )
    headers = {"x-neuralops-agent-key": registration["credential"]}
    request = {
        **authorization_body(registration["identity"]["id"], key="approval-revoke-1"),
        "action": "shell",
        "toolCategory": "shell",
        "operation": "execute",
    }
    pending = secure_client.post("/api/agent-control/authorize", headers=headers, json=request).json()
    approval = pending["approval"]
    assert approval["requestedBy"] == registration["identity"]["id"]

    owner = auth_header("owner-approval-revoke@example.com", "approval-revoke")
    approved = secure_client.post(
        f"/api/agent-control/approvals/{approval['id']}/approve",
        headers={**owner, "Idempotency-Key": "owner-approval-revoke-approve"},
        json={"reason": "Owner reviewed request", "evidenceHash": digest("owner review")},
    )
    assert approved.status_code == 200
    lease = secure_client.post("/api/agent-control/authorize", headers=headers, json=request).json()["lease"]
    assert lease["approvalId"] == approval["id"]
    secondary_lease = {
        **lease,
        "id": "agent_lease_secondary",
        "status": "active",
        "workspaceId": "approval-revoke",
    }
    database.save_record(
        "agent_authorization_leases",
        "approval-revoke:agent_lease_secondary",
        secondary_lease,
    )

    revoked = secure_client.post(
        f"/api/agent-control/approvals/{approval['id']}/revoke",
        headers={**owner, "Idempotency-Key": "owner-approval-revoke-revoke"},
        json={"reason": "Approval withdrawn", "evidenceHash": digest("withdrawal")},
    )
    assert revoked.status_code == 200
    assert revoked.json()["status"] == "revoked"
    stored = database.get_record(
        "agent_authorization_leases",
        f"approval-revoke:{lease['id']}",
    )
    assert stored is not None and stored["status"] == "revoked"
    secondary = database.get_record(
        "agent_authorization_leases",
        "approval-revoke:agent_lease_secondary",
    )
    assert secondary is not None and secondary["status"] == "revoked"


def test_high_risk_approval_persists_and_returns_exact_requested_provider_and_model(
    secure_client: TestClient,
) -> None:
    registration = register(
        secure_client,
        "approval-model",
        providers=["openai"],
        permissions=["shell:execute"],
    )
    request = {
        **authorization_body(registration["identity"]["id"], key="approval-model-1"),
        "action": "shell",
        "toolCategory": "shell",
        "operation": "execute",
        "model": "gpt-5.5-2026-07-01",
    }
    pending = secure_client.post(
        "/api/agent-control/authorize",
        headers={"x-neuralops-agent-key": registration["credential"]},
        json=request,
    )
    assert pending.status_code == 200
    approval = pending.json()["approval"]
    assert approval["provider"] == "openai"
    assert approval["model"] == "gpt-5.5-2026-07-01"

    listed = secure_client.get(
        "/api/agent-control/approvals",
        headers=auth_header("owner-approval-model@example.com", "approval-model"),
    )
    assert listed.status_code == 200
    reviewed = next(item for item in listed.json() if item["id"] == approval["id"])
    assert reviewed["provider"] == "openai"
    assert reviewed["model"] == "gpt-5.5-2026-07-01"


def test_concurrent_approved_authorization_issues_exactly_one_lease(
    secure_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    registration = register(
        secure_client,
        "atomic-issuance",
        providers=["openai"],
        permissions=["shell:execute"],
    )
    agent_headers = {"x-neuralops-agent-key": registration["credential"]}
    request = {
        **authorization_body(registration["identity"]["id"], key="atomic-issuance-1"),
        "action": "shell",
        "toolCategory": "shell",
        "operation": "execute",
        "model": "gpt-5-mini",
    }
    approval = secure_client.post(
        "/api/agent-control/authorize", headers=agent_headers, json=request
    ).json()["approval"]
    approved = secure_client.post(
        f"/api/agent-control/approvals/{approval['id']}/approve",
        headers={
            **auth_header("owner-atomic-issuance@example.com", "atomic-issuance"),
            "Idempotency-Key": "atomic-issuance-approve",
        },
        json={"reason": "Reviewed exact action", "evidenceHash": digest("atomic review")},
    )
    assert approved.status_code == 200

    barrier = Barrier(2)
    original_lookup = main_module.approval_for_action

    def synchronized_lookup(body: Any, environment: str) -> dict[str, Any] | None:
        result = original_lookup(body, environment)
        if result is not None and result.get("status") == "approved":
            barrier.wait(timeout=5)
        return result

    monkeypatch.setattr(main_module, "approval_for_action", synchronized_lookup)
    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(
            executor.map(
                lambda _: secure_client.post(
                    "/api/agent-control/authorize", headers=agent_headers, json=request
                ),
                range(2),
            )
        )
    assert [response.status_code for response in responses] == [200, 200]
    assert responses[0].json() == responses[1].json()
    leases = [
        item
        for item in database.list_records("agent_authorization_leases")
        if item.get("approvalId") == approval["id"]
    ]
    assert len(leases) == 1
    stored_approval = database.get_record(
        "agent_approvals", f"atomic-issuance:{approval['id']}"
    )
    assert stored_approval is not None and stored_approval["status"] == "consumed"


def test_concurrent_lease_consumption_has_exactly_one_winner(
    secure_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    registration = register(secure_client, "atomic-consume")
    headers = {"x-neuralops-agent-key": registration["credential"]}
    body = authorization_body(registration["identity"]["id"], key="atomic-lease")
    lease = secure_client.post("/api/agent-control/authorize", headers=headers, json=body).json()["lease"]
    binding = {**body, "leaseId": lease["id"]}
    wrong_workspace_transition = database.compare_and_set_record_status(
        "agent_authorization_leases",
        f"atomic-consume:{lease['id']}",
        "active",
        "consumed",
        workspace_id="different-workspace",
    )
    assert wrong_workspace_transition is None
    unmodified = database.get_record("agent_authorization_leases", f"atomic-consume:{lease['id']}")
    assert unmodified is not None and unmodified["status"] == "active"
    barrier = Barrier(2)
    original_get = main_module.get_scoped_record

    def synchronized_get(domain: str, record_id: str) -> dict[str, Any] | None:
        payload = original_get(domain, record_id)
        if domain == "agent_authorization_leases" and record_id == lease["id"]:
            barrier.wait(timeout=5)
        return payload

    monkeypatch.setattr(main_module, "get_scoped_record", synchronized_get)
    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(
            executor.map(
                lambda _: secure_client.post(
                    "/api/agent-control/leases/consume",
                    headers=headers,
                    json=binding,
                ),
                range(2),
            )
        )
    assert sorted(response.status_code for response in responses) == [200, 409]


@pytest.mark.parametrize("lifecycle_action", ["revoke", "rotate", "kill-switch"])
def test_low_risk_authorization_cannot_outlive_identity_lifecycle_mutation(
    secure_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    lifecycle_action: str,
) -> None:
    workspace_id = f"issuance-{lifecycle_action}"
    registration = register(secure_client, workspace_id)
    identity_id = registration["identity"]["id"]
    agent_headers = {"x-neuralops-agent-key": registration["credential"]}
    owner_headers = auth_header(f"owner-{workspace_id}@example.com", workspace_id)
    body = authorization_body(identity_id, key=f"race-{lifecycle_action}")
    validated = Event()
    resume = Event()
    original_validate = main_module.validate_agent_action

    def pause_after_identity_validation(identity: dict[str, Any], request: Any) -> tuple[str, str]:
        result = original_validate(identity, request)
        validated.set()
        assert resume.wait(timeout=5)
        return result

    monkeypatch.setattr(main_module, "validate_agent_action", pause_after_identity_validation)
    with ThreadPoolExecutor(max_workers=2) as executor:
        authorization = executor.submit(
            secure_client.post,
            "/api/agent-control/authorize",
            headers=agent_headers,
            json=body,
        )
        assert validated.wait(timeout=5)
        if lifecycle_action == "rotate":
            mutation = secure_client.post(
                f"/api/agent-control/identities/{identity_id}/rotate",
                headers=owner_headers,
            )
        else:
            mutation = secure_client.post(
                f"/api/agent-control/identities/{identity_id}/{lifecycle_action}",
                headers=owner_headers,
                json={"reason": f"Concurrent {lifecycle_action}"},
            )
        assert mutation.status_code == 200
        resume.set()
        response = authorization.result(timeout=5)

    assert response.status_code in {401, 409, 423}
    active = [
        lease
        for lease in database.list_records("agent_authorization_leases")
        if lease.get("identityId") == identity_id and lease.get("status") == "active"
    ]
    assert active == []


def test_high_risk_production_authorization_cannot_outlive_access_revocation(
    secure_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace_id = "issuance-prod-revoke"
    registration = register(
        secure_client,
        workspace_id,
        permissions=["shell:execute"],
    )
    identity_id = registration["identity"]["id"]
    owner_headers = auth_header(f"owner-{workspace_id}@example.com", workspace_id)
    agent_headers = {"x-neuralops-agent-key": registration["credential"]}
    access = secure_client.post(
        "/api/agent-control/production-access",
        headers=owner_headers,
        json={
            "agentId": identity_id,
            "targetEnvironment": "prod",
            "justification": "Production race test",
        },
    ).json()
    approver_headers = add_workspace_member(
        workspace_id, "second-owner-issuance@example.com"
    )
    assert secure_client.post(
        f"/api/agent-control/production-access/{access['id']}/approve",
        headers={**approver_headers, "Idempotency-Key": "prod-race-access-approve"},
        json={"reason": "Pilot approved", "evidenceHash": digest("prod approval")},
    ).status_code == 200
    body = {
        **authorization_body(identity_id, key="prod-revoke-race"),
        "action": "shell",
        "toolCategory": "shell",
        "operation": "execute",
        "environment": "prod",
    }
    pending_response = secure_client.post(
        "/api/agent-control/authorize", headers=agent_headers, json=body
    )
    assert pending_response.status_code == 200, pending_response.text
    pending = pending_response.json()
    assert pending["decision"] == "review", pending
    assert secure_client.post(
        f"/api/agent-control/approvals/{pending['approval']['id']}/approve",
        headers={**owner_headers, "Idempotency-Key": "prod-race-action-approve"},
        json={"reason": "Exact action approved", "evidenceHash": digest("action approval")},
    ).status_code == 200
    validated = Event()
    resume = Event()
    original_validate = main_module.validate_agent_action

    def pause_after_production_validation(identity: dict[str, Any], request: Any) -> tuple[str, str]:
        result = original_validate(identity, request)
        validated.set()
        assert resume.wait(timeout=5)
        return result

    monkeypatch.setattr(main_module, "validate_agent_action", pause_after_production_validation)
    with ThreadPoolExecutor(max_workers=2) as executor:
        authorization = executor.submit(
            secure_client.post,
            "/api/agent-control/authorize",
            headers=agent_headers,
            json=body,
        )
        assert validated.wait(timeout=5)
        revoked = secure_client.post(
            f"/api/agent-control/production-access/{access['id']}/revoke",
            headers={**owner_headers, "Idempotency-Key": "prod-race-access-revoke"},
            json={"reason": "Access withdrawn", "evidenceHash": digest("prod withdrawal")},
        )
        assert revoked.status_code == 200
        resume.set()
        response = authorization.result(timeout=5)

    assert response.status_code in {403, 409}
    active = [
        lease
        for lease in database.list_records("agent_authorization_leases")
        if lease.get("identityId") == identity_id and lease.get("status") == "active"
    ]
    assert active == []


def test_identity_patch_racing_credential_rotation_preserves_the_new_credential_and_hidden_fields(
    secure_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace_id = "stale-patch-rotate"
    registration = register(secure_client, workspace_id)
    identity_id = registration["identity"]["id"]
    owner_headers = auth_header(f"owner-{workspace_id}@example.com", workspace_id)
    record_id = f"{workspace_id}:{identity_id}"
    stored = database.get_record("agent_identities", record_id)
    assert stored is not None
    stored["futureHiddenBoundary"] = {"mode": "preserve", "revision": 7}
    database.save_record("agent_identities", record_id, stored)

    mutation_ready = Event()
    resume_mutation = Event()
    original_mutate = main_module.mutate_agent_identity_and_revoke_leases

    def pause_stale_patch(**kwargs: Any) -> tuple[dict[str, Any] | None, int]:
        if kwargs["reason"] == "Identity boundaries changed":
            mutation_ready.set()
            assert resume_mutation.wait(timeout=5)
        return original_mutate(**kwargs)

    monkeypatch.setattr(main_module, "mutate_agent_identity_and_revoke_leases", pause_stale_patch)
    with ThreadPoolExecutor(max_workers=2) as executor:
        patch_future = executor.submit(
            secure_client.patch,
            f"/api/agent-control/identities/{identity_id}",
            headers=owner_headers,
            json={"owner": "patched-owner@example.com"},
        )
        assert mutation_ready.wait(timeout=5)
        rotated = secure_client.post(
            f"/api/agent-control/identities/{identity_id}/rotate",
            headers=owner_headers,
        )
        assert rotated.status_code == 200
        new_credential = rotated.json()["credential"]
        resume_mutation.set()
        patched = patch_future.result(timeout=5)

    assert patched.status_code == 200
    committed = database.get_record("agent_identities", record_id)
    assert committed is not None
    assert committed["owner"] == "patched-owner@example.com"
    assert committed["credentialHash"] == sha256(new_credential.encode("utf-8")).hexdigest()
    assert committed["futureHiddenBoundary"] == {"mode": "preserve", "revision": 7}
    body = authorization_body(identity_id, key="post-race-new-credential")
    old_key = secure_client.post(
        "/api/agent-control/authorize",
        headers={"x-neuralops-agent-key": registration["credential"]},
        json={**body, "idempotencyKey": "post-race-old-credential"},
    )
    new_key = secure_client.post(
        "/api/agent-control/authorize",
        headers={"x-neuralops-agent-key": new_credential},
        json=body,
    )
    assert old_key.status_code == 401
    assert new_key.status_code == 200


@pytest.mark.parametrize(
    ("operation", "pause_reason"),
    [
        ("production-request", "Production access requires review"),
        ("production-approve", "Production access state changed"),
        ("kill-switch", "Concurrent containment"),
        ("revoke", "Concurrent revocation"),
    ],
)
def test_identity_lifecycle_mutation_racing_rotation_never_restores_stale_credential_state(
    secure_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    operation: str,
    pause_reason: str,
) -> None:
    workspace_id = f"stale-{operation}"
    registration = register(secure_client, workspace_id)
    identity_id = registration["identity"]["id"]
    owner_headers = auth_header(f"owner-{workspace_id}@example.com", workspace_id)
    record_id = f"{workspace_id}:{identity_id}"
    stored = database.get_record("agent_identities", record_id)
    assert stored is not None
    stored["futureHiddenBoundary"] = {"mode": "preserve", "revision": 11}
    database.save_record("agent_identities", record_id, stored)

    access_id: str | None = None
    if operation == "production-approve":
        access = secure_client.post(
            "/api/agent-control/production-access",
            headers=owner_headers,
            json={
                "agentId": identity_id,
                "targetEnvironment": "prod",
                "justification": "Prepare concurrent decision",
            },
        )
        assert access.status_code == 200
        access_id = access.json()["id"]

    mutation_ready = Event()
    resume_mutation = Event()
    original_mutate = main_module.mutate_agent_identity_and_revoke_leases
    original_production_request = main_module.create_agent_production_access_request_atomic
    original_production_decision = main_module.decide_agent_production_access_atomic

    def pause_stale_lifecycle(**kwargs: Any) -> tuple[dict[str, Any] | None, int]:
        if kwargs["reason"] == pause_reason:
            mutation_ready.set()
            assert resume_mutation.wait(timeout=5)
        return original_mutate(**kwargs)

    def pause_production_decision(
        **kwargs: Any,
    ) -> tuple[dict[str, Any] | None, dict[str, Any] | None, int]:
        if operation == "production-approve":
            mutation_ready.set()
            assert resume_mutation.wait(timeout=5)
        return original_production_decision(**kwargs)

    def pause_production_request(
        **kwargs: Any,
    ) -> tuple[dict[str, Any] | None, dict[str, Any] | None, int]:
        if operation == "production-request":
            mutation_ready.set()
            assert resume_mutation.wait(timeout=5)
        return original_production_request(**kwargs)

    monkeypatch.setattr(main_module, "mutate_agent_identity_and_revoke_leases", pause_stale_lifecycle)
    monkeypatch.setattr(
        main_module,
        "create_agent_production_access_request_atomic",
        pause_production_request,
    )
    monkeypatch.setattr(
        main_module,
        "decide_agent_production_access_atomic",
        pause_production_decision,
    )
    production_approver = add_workspace_member(
        workspace_id, f"second-owner-{workspace_id}@example.com"
    )

    def perform_mutation() -> Any:
        if operation == "production-request":
            return secure_client.post(
                "/api/agent-control/production-access",
                headers=owner_headers,
                json={
                    "agentId": identity_id,
                    "targetEnvironment": "prod",
                    "justification": "Concurrent request",
                },
            )
        if operation == "production-approve":
            assert access_id is not None
            return secure_client.post(
                f"/api/agent-control/production-access/{access_id}/approve",
                headers={**production_approver, "Idempotency-Key": "concurrent-production-approve"},
                json={"reason": "Concurrent approval", "evidenceHash": digest("approval")},
            )
        return secure_client.post(
            f"/api/agent-control/identities/{identity_id}/{operation}",
            headers=owner_headers,
            json={"reason": pause_reason},
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        mutation_future = executor.submit(perform_mutation)
        assert mutation_ready.wait(timeout=5)
        rotated = secure_client.post(
            f"/api/agent-control/identities/{identity_id}/rotate",
            headers=owner_headers,
        )
        assert rotated.status_code == 200
        new_credential = rotated.json()["credential"]
        resume_mutation.set()
        mutation_response = mutation_future.result(timeout=5)

    assert mutation_response.status_code == 200
    committed = database.get_record("agent_identities", record_id)
    assert committed is not None
    assert committed["credentialHash"] == sha256(new_credential.encode("utf-8")).hexdigest()
    assert committed["futureHiddenBoundary"] == {"mode": "preserve", "revision": 11}
    old_key = secure_client.post(
        "/api/agent-control/authorize",
        headers={"x-neuralops-agent-key": registration["credential"]},
        json=authorization_body(identity_id, key=f"old-{operation}"),
    )
    assert old_key.status_code == 401
    if operation.startswith("production"):
        new_key = secure_client.post(
            "/api/agent-control/authorize",
            headers={"x-neuralops-agent-key": new_credential},
            json=authorization_body(identity_id, key=f"new-{operation}"),
        )
        assert new_key.status_code == 200
    else:
        assert committed["status"] in {"disabled", "revoked"}


def test_concurrent_identical_approval_requests_are_one_deterministic_record(
    secure_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    registration = register(
        secure_client,
        "approval-create-race",
        permissions=["shell:execute"],
    )
    request = {
        **authorization_body(registration["identity"]["id"], key="same-request"),
        "action": "shell",
        "toolCategory": "shell",
        "operation": "execute",
    }
    headers = {"x-neuralops-agent-key": registration["credential"]}
    barriers = [Barrier(2), Barrier(2)]
    counts: dict[int, int] = {}
    counts_lock = Lock()

    original_lookup = main_module.approval_for_action

    def synchronized_lookup(body: Any, environment: str) -> dict[str, Any] | None:
        thread_id = get_ident()
        with counts_lock:
            call_index = counts.get(thread_id, 0)
            counts[thread_id] = call_index + 1
        if call_index < 2:
            barriers[call_index].wait(timeout=5)
            return None
        return original_lookup(body, environment)

    monkeypatch.setattr(main_module, "approval_for_action", synchronized_lookup)
    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(
            executor.map(
                lambda _: secure_client.post(
                    "/api/agent-control/approvals", headers=headers, json=request
                ),
                range(2),
            )
        )

    assert [response.status_code for response in responses] == [200, 200]
    assert len({response.json()["id"] for response in responses}) == 1
    matching = [
        approval
        for approval in database.list_records("agent_approvals")
        if approval.get("workspaceId") == "approval-create-race"
        and approval.get("identityId") == registration["identity"]["id"]
        and approval.get("idempotencyKey") == "same-request"
    ]
    assert len(matching) == 1


def test_concurrent_approval_decisions_have_one_cas_winner(
    secure_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    registration = register(
        secure_client,
        "approval-decision-race",
        permissions=["shell:execute"],
    )
    request = {
        **authorization_body(registration["identity"]["id"], key="decision-race"),
        "action": "shell",
        "toolCategory": "shell",
        "operation": "execute",
    }
    approval = secure_client.post(
        "/api/agent-control/approvals",
        headers={"x-neuralops-agent-key": registration["credential"]},
        json=request,
    ).json()
    barrier = Barrier(2)
    original_get = main_module.get_scoped_record

    def synchronized_get(domain: str, record_id: str) -> dict[str, Any] | None:
        payload = original_get(domain, record_id)
        if domain == "agent_approvals" and record_id == approval["id"]:
            barrier.wait(timeout=5)
        return payload

    monkeypatch.setattr(main_module, "get_scoped_record", synchronized_get)
    owner = auth_header("owner-approval-decision-race@example.com", "approval-decision-race")
    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(
            executor.map(
                    lambda action: secure_client.post(
                        f"/api/agent-control/approvals/{approval['id']}/{action}",
                        headers={**owner, "Idempotency-Key": f"decision-race-{action}"},
                    json={"reason": f"Concurrent {action}", "evidenceHash": digest(action)},
                ),
                ["approve", "block"],
            )
        )

    assert sorted(response.status_code for response in responses) == [200, 409]
    stored = database.get_record(
        "agent_approvals", f"approval-decision-race:{approval['id']}"
    )
    assert stored is not None
    winner = next(response.json()["status"] for response in responses if response.status_code == 200)
    assert stored["status"] == winner


def test_production_requester_cannot_self_approve_and_competing_decisions_stay_consistent(
    secure_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace_id = "production-decision-race"
    registration = register(secure_client, workspace_id)
    identity_id = registration["identity"]["id"]
    requester_email = f"owner-{workspace_id}@example.com"
    requester = auth_header(requester_email, workspace_id)
    access = secure_client.post(
        "/api/agent-control/production-access",
        headers=requester,
        json={
            "agentId": identity_id,
            "targetEnvironment": "prod",
            "justification": "Production concurrency boundary",
        },
    ).json()
    assert access["requestedBy"] == requester_email
    self_approval = secure_client.post(
        f"/api/agent-control/production-access/{access['id']}/approve",
        headers={**requester, "Idempotency-Key": "self-production-approve"},
        json={"reason": "Self approval attempt", "evidenceHash": digest("self")},
    )
    assert self_approval.status_code == 403

    for email, role in [
        ("second-owner@example.com", "Owner"),
        ("security-reviewer@example.com", "Security"),
    ]:
        database.save_record(
            "workspace_members",
            f"member-{role.lower()}",
            {
                "id": f"member-{role.lower()}",
                "workspaceId": workspace_id,
                "name": role,
                "email": email,
                "role": role,
                "access": "All Workspace" if role == "Owner" else "Security and Audit",
                "createdAt": "2026-07-13T00:00:00",
                "updatedAt": "2026-07-13T00:00:00",
            },
        )

    barrier = Barrier(2)
    original_get = main_module.get_scoped_record

    def synchronized_get(domain: str, record_id: str) -> dict[str, Any] | None:
        payload = original_get(domain, record_id)
        if domain == "agent_access_requests" and record_id == access["id"]:
            barrier.wait(timeout=5)
        return payload

    monkeypatch.setattr(main_module, "get_scoped_record", synchronized_get)
    actors = [
        ("approve", auth_header("second-owner@example.com", workspace_id)),
        ("block", auth_header("security-reviewer@example.com", workspace_id)),
    ]
    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(
            executor.map(
                    lambda item: secure_client.post(
                        f"/api/agent-control/production-access/{access['id']}/{item[0]}",
                        headers={**item[1], "Idempotency-Key": f"production-decision-race-{item[0]}"},
                    json={"reason": f"Concurrent {item[0]}", "evidenceHash": digest(item[0])},
                ),
                actors,
            )
        )

    assert sorted(response.status_code for response in responses) == [200, 409]
    stored_access = database.get_record(
        "agent_access_requests", f"{workspace_id}:{access['id']}"
    )
    stored_identity = database.get_record(
        "agent_identities", f"{workspace_id}:{identity_id}"
    )
    assert stored_access is not None and stored_identity is not None
    expected_identity_status = {
        "approved": "approved",
        "blocked": "blocked",
    }[stored_access["status"]]
    assert stored_identity["productionAccessStatus"] == expected_identity_status


def test_labs_run_respects_kill_switch_and_requires_each_production_lease(
    secure_client: TestClient,
) -> None:
    workspace_id = "lab-governance"
    owner = auth_header(f"owner-{workspace_id}@example.com", workspace_id)
    assert secure_client.get("/api/workspace", headers=owner).status_code == 200
    stopped = secure_client.post(
        "/api/agent-control/identities/support_triage/kill-switch",
        headers=owner,
        json={"reason": "Lab containment test"},
    )
    assert stopped.status_code == 200
    staging = secure_client.post(
        "/api/labs/run",
        headers=owner,
        json={
            "name": "Disabled staging bypass",
            "input": "Do not execute this lab input",
            "agentIds": ["support_triage"],
            "providerMode": "local",
            "environment": "staging",
        },
    )
    assert staging.status_code == 423
    assert "Do not execute this lab input" not in json.dumps(
        database.list_records("agent_runs")
    )

    identity_record_id = f"{workspace_id}:agent_identity_rag_answer"
    assert secure_client.get(
        "/api/agent-control/identities/rag_answer", headers=owner
    ).status_code == 200
    identity = database.get_record("agent_identities", identity_record_id)
    assert identity is not None
    identity["productionAccessStatus"] = "approved"
    identity["environment"] = "all"
    database.save_record("agent_identities", identity_record_id, identity)
    production = secure_client.post(
        "/api/labs/run",
        headers=owner,
        json={
            "name": "Production lease bypass",
            "input": "Production governed input",
            "agentIds": ["rag_answer"],
            "providerMode": "local",
            "provider": "local",
            "model": "local-deterministic-v1",
            "environment": "prod",
            "authorizationLeaseIds": {"rag_answer": "missing-lease"},
            "authorizationContextHashes": {"rag_answer": digest("lab context")},
        },
    )
    assert production.status_code in {403, 409}
    assert "Production governed input" not in json.dumps(
        database.list_records("agent_runs")
    )
