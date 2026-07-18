from collections.abc import Generator
import os
from pathlib import Path
from typing import Any

import jwt
import pytest
from fastapi.testclient import TestClient

from app import database
import app.main as main_module
from app.main import app

TEST_JWT_SECRET = "pilot-test-secret-at-least-32-bytes"


def valid_application(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "name": "Asha Rao",
        "workEmail": "asha@acme.ai",
        "company": "Acme AI",
        "role": "Head of AI Platform",
        "teamSize": "6-20",
        "expectedAgents": 12,
        "primaryUseCase": "Govern production support agents before tool execution.",
        "consent": True,
        "website": "",
    }
    payload.update(overrides)
    return payload


@pytest.fixture()
def client(tmp_path: Path) -> Generator[TestClient]:
    database.DB_PATH = tmp_path / "pilot-applications.sqlite3"
    database.POSTGRES_URL = None
    os.environ["NEURALOPS_DB_PATH"] = str(database.DB_PATH)
    os.environ["NEURALOPS_PILOT_RATE_LIMIT_SALT"] = tmp_path.name
    os.environ["NEURALOPS_PILOT_RATE_LIMIT_MAX"] = "3"
    os.environ.pop("NEURALOPS_DATABASE_URL", None)
    os.environ.pop("SUPABASE_DB_URL", None)
    os.environ.pop("DATABASE_URL", None)
    os.environ.pop("NEURALOPS_AUTH_REQUIRED", None)
    with TestClient(app) as test_client:
        yield test_client
    os.environ.pop("NEURALOPS_PILOT_RATE_LIMIT_SALT", None)
    os.environ.pop("NEURALOPS_PILOT_RATE_LIMIT_MAX", None)


def auth_header(email: str, workspace_id: str = "pilot-ops") -> dict[str, str]:
    token = jwt.encode(
        {
            "sub": email.split("@", 1)[0],
            "email": email,
            "app_metadata": {"neuralops_workspace_id": workspace_id},
        },
        TEST_JWT_SECRET,
        algorithm="HS256",
    )
    return {"Authorization": f"Bearer {token}"}


def test_public_application_is_auth_exempt_but_internal_list_is_not(tmp_path: Path) -> None:
    database.DB_PATH = tmp_path / "pilot-auth.sqlite3"
    database.POSTGRES_URL = None
    os.environ["NEURALOPS_DB_PATH"] = str(database.DB_PATH)
    os.environ["NEURALOPS_AUTH_REQUIRED"] = "true"
    os.environ["SUPABASE_JWT_SECRET"] = TEST_JWT_SECRET
    os.environ["NEURALOPS_PILOT_RATE_LIMIT_SALT"] = tmp_path.name
    os.environ["NEURALOPS_PILOT_OPERATIONS_WORKSPACE_ID"] = "pilot-ops"
    try:
        with TestClient(app) as test_client:
            submitted = test_client.post(
                "/api/public/pilot-applications",
                headers={"Idempotency-Key": "public-without-session"},
                json=valid_application(),
            )
            assert submitted.status_code == 202

            unauthenticated_list = test_client.get("/api/pilot-applications")
            assert unauthenticated_list.status_code == 401

            owner_headers = auth_header("owner@neuralops.ai")
            assert test_client.get("/api/workspace", headers=owner_headers).status_code == 200
            internal_list = test_client.get("/api/pilot-applications", headers=owner_headers)
            assert internal_list.status_code == 200
            assert internal_list.json()[0]["workEmail"] == "asha@acme.ai"
    finally:
        os.environ.pop("NEURALOPS_AUTH_REQUIRED", None)
        os.environ.pop("SUPABASE_JWT_SECRET", None)
        os.environ.pop("NEURALOPS_PILOT_RATE_LIMIT_SALT", None)
        os.environ.pop("NEURALOPS_PILOT_OPERATIONS_WORKSPACE_ID", None)


@pytest.mark.parametrize(
    ("overrides", "expected_status"),
    [
        ({"name": ""}, 422),
        ({"workEmail": "not-an-email"}, 422),
        ({"workEmail": "asha rao@acme.ai"}, 422),
        ({"workEmail": "buyer@mailinator.com"}, 422),
        ({"company": "x" * 161}, 422),
        ({"expectedAgents": 0}, 422),
        ({"primaryUseCase": "x" * 2001}, 422),
        ({"consent": False}, 422),
        ({"unexpected": "field"}, 422),
    ],
)
def test_public_application_rejects_invalid_or_unconsented_input(
    client: TestClient,
    overrides: dict[str, Any],
    expected_status: int,
) -> None:
    response = client.post(
        "/api/public/pilot-applications",
        headers={"Idempotency-Key": f"invalid-{next(iter(overrides))}"},
        json=valid_application(**overrides),
    )
    assert response.status_code == expected_status
    assert database.list_records("pilot_applications") == []


def test_public_application_requires_a_bounded_idempotency_key(client: TestClient) -> None:
    missing = client.post("/api/public/pilot-applications", json=valid_application())
    oversized = client.post(
        "/api/public/pilot-applications",
        headers={"Idempotency-Key": "x" * 161},
        json=valid_application(),
    )

    assert missing.status_code == 422
    assert oversized.status_code == 422
    assert database.list_records("pilot_applications") == []


def test_honeypot_is_silently_accepted_without_persistence(client: TestClient) -> None:
    response = client.post(
        "/api/public/pilot-applications",
        headers={"Idempotency-Key": "bot-submission"},
        json=valid_application(website="https://spam.invalid"),
    )

    assert response.status_code == 202
    assert set(response.json()) == {"applicationId", "status", "submittedAt"}
    assert response.json()["status"] == "received"
    assert database.list_records("pilot_applications") == []


def test_same_idempotency_key_replays_safe_response_and_conflict_is_rejected(client: TestClient) -> None:
    headers = {"Idempotency-Key": "stable-lead-attempt"}
    first = client.post("/api/public/pilot-applications", headers=headers, json=valid_application())
    replay = client.post("/api/public/pilot-applications", headers=headers, json=valid_application())
    conflict = client.post(
        "/api/public/pilot-applications",
        headers=headers,
        json=valid_application(company="Different Company"),
    )

    assert first.status_code == 202
    assert replay.status_code == 202
    assert replay.json() == first.json()
    assert conflict.status_code == 409
    assert len(database.list_records("pilot_applications")) == 1
    assert "workEmail" not in first.json()
    assert "company" not in first.json()


def test_rate_limit_uses_client_fingerprint_and_does_not_persist_address(client: TestClient) -> None:
    for index in range(3):
        accepted = client.post(
            "/api/public/pilot-applications",
            headers={"Idempotency-Key": f"rate-{index}"},
            json=valid_application(workEmail=f"asha{index}@acme.ai"),
        )
        assert accepted.status_code == 202

    limited = client.post(
        "/api/public/pilot-applications",
        headers={"Idempotency-Key": "rate-limited"},
        json=valid_application(workEmail="last@acme.ai"),
    )
    assert limited.status_code == 429
    serialized = str(database.list_records("pilot_applications"))
    assert "testclient" not in serialized
    assert "clientAddress" not in serialized
    assert "ipAddress" not in serialized


def test_rate_limit_prunes_expired_buckets_and_caps_active_fingerprints(client: TestClient) -> None:
    os.environ["NEURALOPS_PILOT_RATE_LIMIT_BUCKET_MAX"] = "2"
    try:
        main_module.PILOT_RATE_LIMIT_BUCKETS.clear()
        main_module.PILOT_RATE_LIMIT_BUCKETS.update(
            {
                "expired-a": [-10_000.0],
                "expired-b": [-9_000.0],
                "active-a": [main_module.perf_counter()],
                "active-b": [main_module.perf_counter()],
                "active-c": [main_module.perf_counter()],
            }
        )

        response = client.post(
            "/api/public/pilot-applications",
            headers={"Idempotency-Key": "bounded-rate-state"},
            json=valid_application(),
        )

        assert response.status_code == 202
        assert len(main_module.PILOT_RATE_LIMIT_BUCKETS) <= 2
        assert "expired-a" not in main_module.PILOT_RATE_LIMIT_BUCKETS
        assert "expired-b" not in main_module.PILOT_RATE_LIMIT_BUCKETS
    finally:
        main_module.PILOT_RATE_LIMIT_BUCKETS.clear()
        os.environ.pop("NEURALOPS_PILOT_RATE_LIMIT_BUCKET_MAX", None)


def test_persisted_application_has_consent_metadata_and_no_agent_content(client: TestClient) -> None:
    response = client.post(
        "/api/public/pilot-applications",
        headers={"Idempotency-Key": "persistence-proof"},
        json=valid_application(),
    )
    assert response.status_code == 202

    records = database.list_records("pilot_applications")
    assert len(records) == 1
    record = records[0]
    assert record["workEmail"] == "asha@acme.ai"
    assert record["consent"] is True
    assert record["consentVersion"] == "invited-pilot-v1"
    assert record["captureMode"] == "lead_metadata_only"
    assert record["source"] == "landing_page"
    assert record["createdAt"]
    assert record["requestHash"].startswith("sha256:")
    assert "prompt" not in record
    assert "output" not in record
    assert "agentContent" not in record


def test_internal_list_allows_owner_and_admin_but_denies_developer(tmp_path: Path) -> None:
    database.DB_PATH = tmp_path / "pilot-rbac.sqlite3"
    database.POSTGRES_URL = None
    os.environ["NEURALOPS_DB_PATH"] = str(database.DB_PATH)
    os.environ["NEURALOPS_AUTH_REQUIRED"] = "true"
    os.environ["SUPABASE_JWT_SECRET"] = TEST_JWT_SECRET
    os.environ["NEURALOPS_PILOT_RATE_LIMIT_SALT"] = tmp_path.name
    os.environ["NEURALOPS_PILOT_OPERATIONS_WORKSPACE_ID"] = "pilot-ops"
    try:
        with TestClient(app) as test_client:
            submitted = test_client.post(
                "/api/public/pilot-applications",
                headers={"Idempotency-Key": "rbac-lead"},
                json=valid_application(),
            )
            assert submitted.status_code == 202

            owner = auth_header("owner@neuralops.ai")
            assert test_client.get("/api/workspace", headers=owner).status_code == 200
            for email, role in (("admin@neuralops.ai", "Admin"), ("dev@neuralops.ai", "Developer")):
                added = test_client.post(
                    "/api/workspace/members",
                    headers=owner,
                    json={"name": role, "email": email, "role": role},
                )
                assert added.status_code == 200

            assert test_client.get("/api/pilot-applications", headers=owner).status_code == 200
            assert test_client.get(
                "/api/pilot-applications", headers=auth_header("admin@neuralops.ai")
            ).status_code == 200
            other_owner = auth_header("other-owner@example.com", "other-workspace")
            assert test_client.get("/api/workspace", headers=other_owner).status_code == 200
            assert test_client.get("/api/pilot-applications", headers=other_owner).json() == []
            denied = test_client.get(
                "/api/pilot-applications", headers=auth_header("dev@neuralops.ai")
            )
            assert denied.status_code == 403
            assert denied.json()["detail"]["requiredPermission"] == "workspace:write"
    finally:
        os.environ.pop("NEURALOPS_AUTH_REQUIRED", None)
        os.environ.pop("SUPABASE_JWT_SECRET", None)
        os.environ.pop("NEURALOPS_PILOT_RATE_LIMIT_SALT", None)
        os.environ.pop("NEURALOPS_PILOT_OPERATIONS_WORKSPACE_ID", None)


def test_pilot_applications_are_in_data_governance_inventory(client: TestClient) -> None:
    submitted = client.post(
        "/api/public/pilot-applications",
        headers={"Idempotency-Key": "governed-lead"},
        json=valid_application(),
    )
    assert submitted.status_code == 202

    inventory = client.get("/api/data-governance/inventory")
    assert inventory.status_code == 200
    pilot_domain = next(item for item in inventory.json() if item["domain"] == "pilot_applications")
    assert pilot_domain["totalRecords"] == 1


def test_expired_pilot_lead_purge_deletes_physical_record_and_reports_truth(client: TestClient) -> None:
    submitted = client.post(
        "/api/public/pilot-applications",
        headers={"Idempotency-Key": "expired-governed-lead"},
        json=valid_application(),
    )
    assert submitted.status_code == 202
    stored = database.list_domain_records_with_ids("pilot_applications")
    assert len(stored) == 1
    physical_id = stored[0]["id"]
    payload = stored[0]["payload"]
    payload["createdAt"] = "2024-01-01T00:00:00"
    database.save_record("pilot_applications", physical_id, payload)

    policy = client.put(
        "/api/data-governance/policy",
        json={"retentionDays": 30, "domains": ["pilot_applications"], "mode": "enforced"},
    )
    assert policy.status_code == 200
    simulation = client.post(
        "/api/data-governance/purge/simulate",
        json={"domains": ["pilot_applications"]},
    ).json()
    assert simulation["eligibleRecords"] == 1

    purge = client.post(
        "/api/data-governance/purge/run",
        json={"simulationId": simulation["id"], "confirmation": simulation["confirmation"]},
    )

    assert purge.status_code == 200
    assert purge.json()["deletedRecords"] == 1
    assert database.get_record("pilot_applications", physical_id) is None
    evidence = client.get("/api/data-governance/evidence").json()
    pilot_inventory = next(item for item in evidence["inventory"] if item["domain"] == "pilot_applications")
    assert pilot_inventory["totalRecords"] == 0
    assert evidence["latestPurgeJob"]["deletedRecords"] == 1
