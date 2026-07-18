from collections.abc import Generator
import json
import os
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient
import pytest

from app import database
from app.main import app


@pytest.fixture()
def client(tmp_path: Path) -> Generator[TestClient]:
    database.DB_PATH = tmp_path / "decision-idempotency.sqlite3"
    database.POSTGRES_URL = None
    os.environ["NEURALOPS_DB_PATH"] = str(database.DB_PATH)
    os.environ.pop("NEURALOPS_AUTH_REQUIRED", None)
    with TestClient(app) as test_client:
        yield test_client


def register_high_risk_agent(client: TestClient, name: str) -> dict[str, Any]:
    response = client.post(
        "/api/agent-control/identities",
        json={
            "displayName": name,
            "owner": "pilot-owner@example.com",
            "environment": "all",
            "riskLevel": "Critical",
            "providerAccess": ["local"],
            "permissions": ["shell:execute", "metadata:read"],
        },
    )
    assert response.status_code == 200
    return response.json()


def request_shell_approval(client: TestClient, registration: dict[str, Any], key: str) -> dict[str, Any]:
    response = client.post(
        "/api/agent-control/approvals",
        headers={"x-neuralops-agent-key": registration["credential"]},
        json={
            "identityId": registration["identity"]["id"],
            "action": "shell",
            "toolCategory": "shell",
            "operation": "deploy",
            "contextHash": f"sha256:{'a' * 64}",
            "contentHash": f"sha256:{'b' * 64}",
            "provider": "local",
            "environment": "staging",
            "idempotencyKey": key,
        },
    )
    assert response.status_code == 200
    return response.json()


def decision_payload(reason: str = "Reviewed production operation") -> dict[str, str]:
    return {"reason": reason, "evidenceHash": f"sha256:{'e' * 64}"}


@pytest.mark.parametrize(
    "evidence_hash",
    ["foo", "sha256:short", f"sha256:{'G' * 64}", f"sha256:{'a' * 63}z"],
)
def test_decision_rejects_non_canonical_evidence_hash(client: TestClient, evidence_hash: str) -> None:
    registration = register_high_risk_agent(client, "Evidence integrity")
    approval = request_shell_approval(client, registration, f"evidence-{len(evidence_hash)}-{evidence_hash[-1]}")
    response = client.post(
        f"/api/agent-control/approvals/{approval['id']}/approve",
        headers={"Idempotency-Key": f"evidence-decision-{len(evidence_hash)}-{evidence_hash[-1]}"},
        json={"reason": "Evidence must be tamper evident", "evidenceHash": evidence_hash},
    )
    assert response.status_code == 422


def test_approval_decision_requires_bounded_idempotency_key(client: TestClient) -> None:
    registration = register_high_risk_agent(client, "Required decision key")
    approval = request_shell_approval(client, registration, "action-required-key")

    missing = client.post(
        f"/api/agent-control/approvals/{approval['id']}/approve",
        json=decision_payload(),
    )
    oversized = client.post(
        f"/api/agent-control/approvals/{approval['id']}/approve",
        headers={"Idempotency-Key": "x" * 161},
        json=decision_payload(),
    )

    assert missing.status_code == 422
    assert oversized.status_code == 422
    assert client.get("/api/agent-control/approvals").json()[0]["status"] == "pending"


def test_approval_decision_replays_original_result_and_conflicts_on_rebinding(client: TestClient) -> None:
    registration = register_high_risk_agent(client, "Replay-safe approval")
    approval = request_shell_approval(client, registration, "action-replay-key")
    endpoint = f"/api/agent-control/approvals/{approval['id']}/approve"
    headers = {"Idempotency-Key": "approval-decision-key"}

    first = client.post(endpoint, headers=headers, json=decision_payload())
    replay = client.post(endpoint, headers=headers, json=decision_payload())
    conflict = client.post(
        endpoint,
        headers=headers,
        json=decision_payload("A different review reason"),
    )
    cross_decision = client.post(
        f"/api/agent-control/approvals/{approval['id']}/block",
        headers=headers,
        json=decision_payload(),
    )

    assert first.status_code == 200
    assert replay.status_code == 200
    assert replay.json() == first.json()
    assert conflict.status_code == 409
    assert "Idempotency" in str(conflict.json()["detail"])
    assert cross_decision.status_code == 409
    assert "Idempotency" in str(cross_decision.json()["detail"])

    revoked = client.post(
        f"/api/agent-control/approvals/{approval['id']}/revoke",
        headers={"Idempotency-Key": "approval-revoke-key"},
        json=decision_payload("Approval withdrawn"),
    )
    replay_after_revoke = client.post(endpoint, headers=headers, json=decision_payload())
    assert revoked.status_code == 200
    assert revoked.json()["status"] == "revoked"
    assert replay_after_revoke.status_code == 200
    assert replay_after_revoke.json() == first.json()

    stored = database.get_record("agent_approvals", approval["id"])
    assert stored is not None
    serialized = json.dumps(stored)
    assert "approval-decision-key" not in serialized
    assert "approval-revoke-key" not in serialized
    assert len(stored["decisionHistory"]) == 2


def test_production_access_decision_is_replay_safe_and_bound(client: TestClient) -> None:
    registration = register_high_risk_agent(client, "Replay-safe production access")
    access = client.post(
        "/api/agent-control/production-access",
        json={
            "agentId": registration["identity"]["id"],
            "targetEnvironment": "prod",
            "justification": "Required for the invited production pilot",
        },
    )
    assert access.status_code == 200
    endpoint = f"/api/agent-control/production-access/{access.json()['id']}/approve"
    headers = {"Idempotency-Key": "production-decision-key"}

    first = client.post(endpoint, headers=headers, json=decision_payload("Production approved"))
    replay = client.post(endpoint, headers=headers, json=decision_payload("Production approved"))
    conflict = client.post(
        endpoint,
        headers=headers,
        json=decision_payload("Changed production justification"),
    )

    assert first.status_code == 200
    assert replay.status_code == 200
    assert replay.json() == first.json()
    assert conflict.status_code == 409
    assert "Idempotency" in str(conflict.json()["detail"])

    revoked = client.post(
        f"/api/agent-control/production-access/{access.json()['id']}/revoke",
        headers={"Idempotency-Key": "production-revoke-key"},
        json=decision_payload("Production access withdrawn"),
    )
    replay_after_revoke = client.post(
        endpoint,
        headers=headers,
        json=decision_payload("Production approved"),
    )
    assert revoked.status_code == 200
    assert replay_after_revoke.status_code == 200
    assert replay_after_revoke.json() == first.json()

    stored = database.get_record("agent_access_requests", access.json()["id"])
    assert stored is not None
    serialized = json.dumps(stored)
    assert "production-decision-key" not in serialized
    assert "production-revoke-key" not in serialized
    assert len(stored["decisionHistory"]) == 2
