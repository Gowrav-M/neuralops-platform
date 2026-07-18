from __future__ import annotations

from collections.abc import Generator
from io import BytesIO
import os
from pathlib import Path
import sys
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urlsplit

import pytest
from fastapi.testclient import TestClient

from app import database
from app.main import app


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sdk" / "python"))

from neuralops import (  # noqa: E402
    AGENT_ACTION_METADATA_READ,
    AGENT_ACTION_SHELL,
    AGENT_TOOL_CATEGORY_METADATA,
    AGENT_TOOL_CATEGORY_SHELL,
    NeuralOpsAuthorizationError,
    NeuralOpsClient,
)


class AdapterResponse:
    def __init__(self, body: bytes) -> None:
        self._body = body

    def __enter__(self) -> "AdapterResponse":
        return self

    def __exit__(self, *_args: Any) -> None:
        return None

    def read(self) -> bytes:
        return self._body


@pytest.fixture()
def real_service(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Generator[TestClient]:
    database.DB_PATH = tmp_path / "sdk-contract.sqlite3"
    database.POSTGRES_URL = None
    monkeypatch.setenv("NEURALOPS_DB_PATH", str(database.DB_PATH))
    monkeypatch.delenv("NEURALOPS_DATABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_DB_URL", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("NEURALOPS_AUTH_REQUIRED", raising=False)
    with TestClient(app) as client:
        yield client


def install_testclient_urlopen(monkeypatch: pytest.MonkeyPatch, client: TestClient) -> None:
    def urlopen_adapter(request, timeout):  # noqa: ANN001
        del timeout
        parsed = urlsplit(request.full_url)
        response = client.request(
            request.get_method(),
            parsed.path,
            headers=dict(request.header_items()),
            content=request.data,
        )
        if response.status_code >= 400:
            raise HTTPError(
                request.full_url,
                response.status_code,
                response.reason_phrase,
                response.headers,
                BytesIO(response.content),
            )
        return AdapterResponse(response.content)

    monkeypatch.setattr("neuralops.urlopen", urlopen_adapter)


def register_contract_identity(client: TestClient) -> dict[str, Any]:
    response = client.post(
        "/api/agent-control/identities",
        json={
            "displayName": "SDK Contract Agent",
            "owner": "sdk-contract@example.com",
            "environment": "staging",
            "riskLevel": "Critical",
            "providerAccess": ["gateway"],
            "permissions": ["metadata:read", "shell:execute"],
        },
    )
    assert response.status_code == 200
    return response.json()


def action_metadata(identity_id: str, *, action: str, tool_category: str, idempotency_key: str) -> dict[str, Any]:
    return {
        "identity_id": identity_id,
        "action": action,
        "tool_category": tool_category,
        "operation": "inspect" if action == AGENT_ACTION_METADATA_READ else "exec",
        "context_hash": f"sha256:{'a' * 64}",
        "content_hash": f"sha256:{'b' * 64}",
        "provider": "gateway",
        "environment": "staging",
        "idempotency_key": idempotency_key,
    }


def test_python_sdk_contract_against_real_fastapi_service(
    real_service: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    registration = register_contract_identity(real_service)
    install_testclient_urlopen(monkeypatch, real_service)
    sdk = NeuralOpsClient(agent_credential=registration["credential"], base_url="http://testserver")
    identity_id = registration["identity"]["id"]

    low_risk = action_metadata(
        identity_id,
        action=AGENT_ACTION_METADATA_READ,
        tool_category=AGENT_TOOL_CATEGORY_METADATA,
        idempotency_key="python-low-risk-contract",
    )
    lease = sdk.authorize_action(**low_risk)
    assert lease["risk"] == "low"
    assert lease["action"] == AGENT_ACTION_METADATA_READ
    assert lease["toolCategory"] == AGENT_TOOL_CATEGORY_METADATA
    binding = {**low_risk, "lease_id": lease["id"]}
    assert sdk.validate_lease(**binding)["status"] == "active"
    assert sdk.consume_lease(**binding)["status"] == "consumed"

    high_risk = action_metadata(
        identity_id,
        action=AGENT_ACTION_SHELL,
        tool_category=AGENT_TOOL_CATEGORY_SHELL,
        idempotency_key="python-high-risk-contract",
    )
    requested_approval = sdk.request_approval(**high_risk)
    assert requested_approval["status"] == "pending"
    assert requested_approval["identityId"] == identity_id
    with pytest.raises(NeuralOpsAuthorizationError) as first:
        sdk.authorize_action(**high_risk)
    assert first.value.code == "approval_required"
    assert first.value.idempotency_key == "python-high-risk-contract"

    with pytest.raises(NeuralOpsAuthorizationError) as replay:
        sdk.authorize_action(**high_risk)
    assert replay.value.code == "approval_required"
    assert replay.value.idempotency_key == first.value.idempotency_key
    assert replay.value.approval == first.value.approval
    assert replay.value.approval["id"] == requested_approval["id"]
