from __future__ import annotations

import json
import logging
import os
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any

from . import seed
from .config import load_local_env

load_local_env()
ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
DB_PATH = Path(os.getenv("NEURALOPS_DB_PATH", DATA_DIR / "neuralops.sqlite3"))
POSTGRES_URL = os.getenv("NEURALOPS_DATABASE_URL") or os.getenv("SUPABASE_DB_URL") or os.getenv("DATABASE_URL")
POSTGRES_SCHEMA = os.getenv("NEURALOPS_POSTGRES_SCHEMA", "neuralops_private")
POSTGRES_TABLE = os.getenv("NEURALOPS_POSTGRES_TABLE", "records")
LOGGER = logging.getLogger(__name__)


def storage_backend() -> str:
    return "postgres" if POSTGRES_URL else "sqlite"


def database_connection_options() -> dict[str, Any]:
    connect_timeout = max(1, int(os.getenv("NEURALOPS_DB_CONNECT_TIMEOUT_SECONDS", "5")))
    statement_timeout = max(1000, int(os.getenv("NEURALOPS_DB_STATEMENT_TIMEOUT_MS", "15000")))
    return {
        "connect_timeout": connect_timeout,
        "options": f"-c statement_timeout={statement_timeout}",
    }


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    if POSTGRES_URL:
        init_postgres()
    else:
        init_sqlite()
    seed_if_empty()
    cleanup_legacy_demo_records()


def probe_database() -> bool:
    """Run a bounded storage round-trip for readiness checks."""
    if POSTGRES_URL:
        with postgres_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute("SELECT 1")
                return cursor.fetchone() == (1,)
    with connect() as conn:
        return conn.execute("SELECT 1").fetchone()[0] == 1


def init_sqlite() -> None:
    with connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS records (
              domain TEXT NOT NULL,
              id TEXT NOT NULL,
              payload TEXT NOT NULL,
              updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              PRIMARY KEY (domain, id)
            )
            """
        )
        conn.commit()


def init_postgres() -> None:
    with postgres_connection() as conn:
        with conn.cursor() as cursor:
            cursor.execute(f"CREATE SCHEMA IF NOT EXISTS {quote_ident(POSTGRES_SCHEMA)}")
            cursor.execute(
                f"""
                CREATE TABLE IF NOT EXISTS {pg_table()} (
                  domain text NOT NULL,
                  id text NOT NULL,
                  payload jsonb NOT NULL,
                  created_at timestamptz NOT NULL DEFAULT now(),
                  updated_at timestamptz NOT NULL DEFAULT now(),
                  PRIMARY KEY (domain, id)
                )
                """
            )
            cursor.execute(f"CREATE INDEX IF NOT EXISTS records_domain_updated_at_idx ON {pg_table()} (domain, updated_at DESC)")
            cursor.execute(f"CREATE INDEX IF NOT EXISTS records_payload_gin_idx ON {pg_table()} USING gin (payload)")
        conn.commit()
    maybe_enable_postgres_rls()


def maybe_enable_postgres_rls() -> None:
    """Optional safety migration for self-hosted installs.

    Production Supabase RLS is managed by versioned SQL migrations. Running
    ALTER TABLE during every web-service boot can block behind active sessions
    and make Render fail health checks, so startup only attempts this when
    explicitly requested.
    """
    if os.getenv("NEURALOPS_ENABLE_POSTGRES_RLS_ON_STARTUP", "").lower() not in {"1", "true", "yes"}:
        return
    try:
        with postgres_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute("SET LOCAL lock_timeout = '3s'")
                cursor.execute("SET LOCAL statement_timeout = '8s'")
                cursor.execute(f"ALTER TABLE {pg_table()} ENABLE ROW LEVEL SECURITY")
            conn.commit()
    except Exception as exc:  # pragma: no cover - defensive production guard
        LOGGER.warning("Skipped startup RLS enablement for %s: %s", pg_table(), exc)


def seed_if_empty() -> None:
    if count_records() > 0:
        return
    for policy in seed.POLICIES:
        save_record("policies", policy["id"], policy)
    save_record("settings", "current", seed.SETTINGS)


def cleanup_legacy_demo_records() -> None:
    fake_domains = (
        "stats",
        "traces",
        "incidents",
        "prompts",
        "evals",
        "rag",
        "policy_violations",
        "agents",
        "agent_runs",
        "audit",
        "costs",
    )
    for domain in fake_domains:
        for record in list_domain_records_with_ids(domain):
            if is_fake_record(domain, record["id"], record["payload"]):
                delete_record(domain, record["id"])

    current_settings = get_record("settings", "current")
    if current_settings is None:
        return
    for key in ("ssoStatus", "billingPlan", "nextInvoice"):
        if key not in current_settings:
            current_settings[key] = seed.SETTINGS.get(key)
    for webhook in current_settings.get("webhooks", []):
        if webhook.get("url") == "https://hooks.slack.com/services/demo":
            webhook["name"] = "Operations Alert Receiver"
            webhook["url"] = "https://hooks.example.invalid/neuralops"
    clean_settings_artifacts(current_settings)
    save_record("settings", "current", current_settings)


def is_fake_record(domain: str, record_id: str, payload: dict[str, Any]) -> bool:
    if domain in {"stats", "costs"}:
        return True
    if domain in {"prompts", "evals", "rag", "policy_violations", "agents"}:
        return record_id.startswith(("prompt_", "eval_", "q_", "vio_", "agent_"))
    if domain == "incidents":
        return record_id.startswith("inc_")
    if domain == "traces":
        text = json.dumps(payload).lower()
        fake_markers = (
            "quantum computing",
            "capital of turkey",
            "simulated api client",
            "pytest",
            "shell_verified",
            "browser_ingest",
            "sess_",
            "web_search_connector",
            "otel_a0fd88bad001",
        )
        if payload.get("source") == "seed":
            return True
        return any(marker in text for marker in fake_markers)
    if domain == "agent_runs":
        text = json.dumps(payload).lower()
        fake_markers = (
            "pytest",
            "shell_verified",
            "browser_ingest",
        )
        return any(marker in text for marker in fake_markers)
    if domain == "audit":
        text = json.dumps(payload).lower()
        fake_markers = ("pytest", "shell_ingest", "browser_ingest", "shell_verified")
        return any(marker in text for marker in fake_markers)
    return False


def clean_settings_artifacts(payload: dict[str, Any]) -> None:
    blocked_labels = (
        "pytest",
        "shell_ingest",
        "browser_ingest",
        "browser_audit",
        "audit_backend",
        "production sdk",
        "staging ingest",
        "demo",
        "key_01",
        "key_02",
    )
    payload["apiKeys"] = [
        key for key in payload.get("apiKeys", [])
        if not any(label in json.dumps(key).lower() for label in blocked_labels)
    ]
    payload["webhooks"] = [
        webhook for webhook in payload.get("webhooks", [])
        if not any(label in json.dumps(webhook).lower() for label in (*blocked_labels, "example.invalid"))
    ]
    payload["teamMembers"] = [
        member for member in payload.get("teamMembers", [])
        if "neuralops.local" not in json.dumps(member).lower()
    ]
    if payload.get("billingPlan") == "Local seeded workspace":
        payload["billingPlan"] = seed.SETTINGS["billingPlan"]


def count_records() -> int:
    if POSTGRES_URL:
        with postgres_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute(f"SELECT COUNT(*) FROM {pg_table()}")
                return int(cursor.fetchone()[0])
    with connect() as conn:
        return int(conn.execute("SELECT COUNT(*) FROM records").fetchone()[0])


def list_records(domain: str) -> list[dict[str, Any]]:
    return [item["payload"] for item in list_domain_records_with_ids(domain)]


def list_records_for_workspace(domain: str, workspace_id: str, global_domains: set[str] | None = None) -> list[dict[str, Any]]:
    global_domains = global_domains or set()
    if domain in global_domains:
        return list_records(domain)
    if POSTGRES_URL:
        with postgres_connection() as conn:
            with conn.cursor() as cursor:
                if domain == "workspaces":
                    cursor.execute(
                        f"SELECT id, payload FROM {pg_table()} WHERE domain = %s AND (id = %s OR payload->>'id' = %s) ORDER BY id",
                        (domain, workspace_id, workspace_id),
                    )
                else:
                    cursor.execute(
                        f"SELECT id, payload FROM {pg_table()} WHERE domain = %s AND payload->>'workspaceId' = %s ORDER BY id",
                        (domain, workspace_id),
                    )
                rows = cursor.fetchall()
        return [normalize_payload(row[1]) for row in rows]
    records = list_domain_records_with_ids(domain)
    if domain == "workspaces":
        return [item["payload"] for item in records if item["payload"].get("id") == workspace_id]
    return [item["payload"] for item in records if item["payload"].get("workspaceId") == workspace_id]


def count_records_for_workspace(domains: list[str], workspace_id: str, global_domains: set[str] | None = None) -> dict[str, int]:
    global_domains = global_domains or set()
    counts = {domain: 0 for domain in domains}
    if POSTGRES_URL:
        global_list = list(global_domains) or ["__none__"]
        with postgres_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    f"""
                    SELECT domain, COUNT(*)
                    FROM {pg_table()}
                    WHERE domain = ANY(%s)
                      AND (
                        domain = ANY(%s)
                        OR (domain = 'workspaces' AND (id = %s OR payload->>'id' = %s))
                        OR payload->>'workspaceId' = %s
                      )
                    GROUP BY domain
                    """,
                    (domains, global_list, workspace_id, workspace_id, workspace_id),
                )
                rows = cursor.fetchall()
        counts.update({row[0]: int(row[1]) for row in rows})
        return counts
    for domain in domains:
        counts[domain] = len(list_records_for_workspace(domain, workspace_id, global_domains))
    return counts


def list_domain_records_with_ids(domain: str) -> list[dict[str, Any]]:
    if POSTGRES_URL:
        with postgres_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    f"SELECT id, payload FROM {pg_table()} WHERE domain = %s ORDER BY id",
                    (domain,),
                )
                rows = cursor.fetchall()
        return [{"id": row[0], "payload": normalize_payload(row[1])} for row in rows]
    with connect() as conn:
        rows = conn.execute("SELECT id, payload FROM records WHERE domain = ? ORDER BY id", (domain,)).fetchall()
    return [{"id": row["id"], "payload": json.loads(row["payload"])} for row in rows]


def get_record(domain: str, record_id: str) -> dict[str, Any] | None:
    if POSTGRES_URL:
        with postgres_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    f"SELECT payload FROM {pg_table()} WHERE domain = %s AND id = %s",
                    (domain, record_id),
                )
                row = cursor.fetchone()
        return normalize_payload(row[0]) if row else None
    with connect() as conn:
        row = conn.execute("SELECT payload FROM records WHERE domain = ? AND id = ?", (domain, record_id)).fetchone()
    return json.loads(row["payload"]) if row else None


def get_active_agent_identity_by_credential_hash(
    credential_hash: str,
) -> dict[str, Any] | None:
    """Resolve exactly one usable identity without scanning credential records."""
    if POSTGRES_URL:
        with postgres_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    f"""
                    SELECT payload FROM {pg_table()}
                    WHERE domain = %s AND payload->>'credentialHash' = %s
                    LIMIT 2
                    """,
                    ("agent_identities", credential_hash),
                )
                rows = cursor.fetchall()
        identities = [normalize_payload(row[0]) for row in rows]
    else:
        with connect() as conn:
            rows = conn.execute(
                """
                SELECT payload FROM records
                WHERE domain = ? AND json_extract(payload, '$.credentialHash') = ?
                LIMIT 2
                """,
                ("agent_identities", credential_hash),
            ).fetchall()
        identities = [json.loads(row["payload"]) for row in rows]
    if len(identities) != 1:
        return None
    identity = identities[0]
    if (
        identity.get("credentialStatus") != "active"
        or identity.get("status") in {"disabled", "revoked"}
    ):
        return None
    return identity


def save_record(domain: str, record_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    if POSTGRES_URL:
        with postgres_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    f"""
                    INSERT INTO {pg_table()} (domain, id, payload)
                    VALUES (%s, %s, %s::jsonb)
                    ON CONFLICT (domain, id)
                    DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()
                    """,
                    (domain, record_id, json.dumps(payload, separators=(",", ":"))),
                )
            conn.commit()
        return payload
    with connect() as conn:
        insert_sqlite(conn, domain, record_id, payload)
        conn.commit()
    return payload


def cancel_agent_jobs_atomic(
    *,
    workspace_id: str,
    identity_ids: set[str],
    now_iso: str,
    environment: str | None = None,
) -> int:
    """Cancel every queued or claimed job for an identity within one workspace."""
    aliases = sorted(value for value in identity_ids if value)
    if not aliases:
        return 0
    patch = {"status": "cancelled", "updatedAt": now_iso, "finishedAt": now_iso}
    if POSTGRES_URL:
        with postgres_connection() as conn:
            with conn.cursor() as cursor:
                environment_sql = "AND payload->'request'->>'environment' = %s" if environment else ""
                params: list[Any] = [json.dumps(patch, separators=(",", ":")), workspace_id, aliases]
                if environment:
                    params.append(environment)
                cursor.execute(
                    f"""
                    UPDATE {pg_table()}
                    SET payload = payload || %s::jsonb, updated_at = now()
                    WHERE domain = 'agent_jobs'
                      AND payload->>'workspaceId' = %s
                      AND payload->'request'->>'agentId' = ANY(%s)
                      AND payload->>'status' IN ('queued', 'running')
                      {environment_sql}
                    """,
                    tuple(params),
                )
                cancelled = cursor.rowcount
            conn.commit()
        return cancelled

    cancelled = 0
    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        rows = conn.execute(
            "SELECT id, payload FROM records WHERE domain = ?",
            ("agent_jobs",),
        ).fetchall()
        for row in rows:
            payload = json.loads(row["payload"])
            request = payload.get("request") if isinstance(payload.get("request"), dict) else {}
            if (
                payload.get("workspaceId") != workspace_id
                or request.get("agentId") not in identity_ids
                or payload.get("status") not in {"queued", "running"}
                or (environment is not None and request.get("environment") != environment)
            ):
                continue
            payload.update(patch)
            conn.execute(
                "UPDATE records SET payload = ?, updated_at = CURRENT_TIMESTAMP WHERE domain = ? AND id = ?",
                (json.dumps(payload, separators=(",", ":")), "agent_jobs", row["id"]),
            )
            cancelled += 1
        conn.commit()
    return cancelled


def insert_record_if_absent(
    domain: str,
    record_id: str,
    payload: dict[str, Any],
) -> tuple[dict[str, Any], bool]:
    """Insert one immutable identity for an idempotent request.

    The primary key is the serialization point. Concurrent callers receive the
    same persisted payload and never replace the winner's request binding.
    """
    if POSTGRES_URL:
        with postgres_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    f"""
                    INSERT INTO {pg_table()} (domain, id, payload)
                    VALUES (%s, %s, %s::jsonb)
                    ON CONFLICT (domain, id) DO NOTHING
                    RETURNING payload
                    """,
                    (domain, record_id, json.dumps(payload, separators=(",", ":"))),
                )
                row = cursor.fetchone()
                created = row is not None
                if row is None:
                    cursor.execute(
                        f"SELECT payload FROM {pg_table()} WHERE domain = %s AND id = %s",
                        (domain, record_id),
                    )
                    row = cursor.fetchone()
            conn.commit()
        if row is None:
            raise RuntimeError("Idempotent record disappeared during insertion")
        return normalize_payload(row[0]), created

    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT payload FROM records WHERE domain = ? AND id = ?",
            (domain, record_id),
        ).fetchone()
        if row is not None:
            conn.commit()
            return json.loads(row["payload"]), False
        conn.execute(
            """
            INSERT INTO records(domain, id, payload, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            """,
            (domain, record_id, json.dumps(payload, separators=(",", ":"))),
        )
        conn.commit()
        return payload, True


def create_agent_production_access_request_atomic(
    *,
    workspace_id: str,
    identity_record_id: str,
    identity_id: str,
    access_record_id: str,
    access_payload: dict[str, Any],
    now_iso: str,
    revoke_reason: str,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None, int]:
    """Create a production request and all identity effects in one transaction."""
    if access_payload.get("workspaceId") != workspace_id:
        raise ValueError("Production access request must be bound to its workspace")

    def apply_request_state(identity: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        blocked = identity.get("status") in {"disabled", "revoked"}
        access = dict(access_payload)
        access.update(
            status="blocked" if blocked else "pending_review",
            decision="block" if blocked else "review",
            reviewedAt=now_iso if blocked else None,
        )
        identity.update(
            productionAccessStatus="blocked" if blocked else "pending_review",
            lastApprovedAt=None,
            updatedAt=now_iso,
        )
        return identity, access

    def supersede(payload: dict[str, Any]) -> dict[str, Any]:
        payload.update(
            status="revoked",
            decision="block",
            reviewedAt=now_iso,
            reason="Superseded by a newer production access request",
        )
        return payload

    if POSTGRES_URL:
        with postgres_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    f"SELECT payload FROM {pg_table()} WHERE domain = %s AND id = %s FOR UPDATE",
                    ("agent_identities", identity_record_id),
                )
                row = cursor.fetchone()
                if row is None:
                    conn.rollback()
                    return None, None, 0
                identity = normalize_payload(row[0])
                if identity.get("workspaceId") != workspace_id:
                    conn.rollback()
                    return None, None, 0
                aliases = list(
                    {
                        identity_id,
                        str(identity.get("id", identity_id)),
                        str(identity.get("agentId", identity_id)),
                        str(access_payload.get("agentId", identity_id)),
                    }
                )
                cursor.execute(
                    f"""
                    SELECT id, payload FROM {pg_table()}
                    WHERE domain = 'agent_access_requests'
                      AND payload->>'workspaceId' = %s
                      AND payload->>'agentId' = ANY(%s)
                      AND payload->>'status' = 'pending_review'
                    FOR UPDATE
                    """,
                    (workspace_id, aliases),
                )
                pending_rows = cursor.fetchall()
                identity, access = apply_request_state(identity)
                for sibling_id, sibling_payload in pending_rows:
                    sibling = supersede(normalize_payload(sibling_payload))
                    cursor.execute(
                        f"UPDATE {pg_table()} SET payload = %s::jsonb, updated_at = now() WHERE domain = %s AND id = %s",
                        (json.dumps(sibling, separators=(",", ":")), "agent_access_requests", sibling_id),
                    )
                cursor.execute(
                    f"INSERT INTO {pg_table()} (domain, id, payload) VALUES (%s, %s, %s::jsonb)",
                    ("agent_access_requests", access_record_id, json.dumps(access, separators=(",", ":"))),
                )
                cursor.execute(
                    f"UPDATE {pg_table()} SET payload = %s::jsonb, updated_at = now() WHERE domain = %s AND id = %s",
                    (json.dumps(identity, separators=(",", ":")), "agent_identities", identity_record_id),
                )
                lease_patch = {
                    "status": "revoked",
                    "revokedAt": now_iso,
                    "revokeReason": revoke_reason,
                }
                cursor.execute(
                    f"""
                    UPDATE {pg_table()} SET payload = payload || %s::jsonb, updated_at = now()
                    WHERE domain = 'agent_authorization_leases'
                      AND payload->>'workspaceId' = %s
                      AND payload->>'identityId' = ANY(%s)
                      AND payload->>'environment' = 'prod'
                      AND payload->>'status' = 'active'
                    """,
                    (json.dumps(lease_patch, separators=(",", ":")), workspace_id, aliases),
                )
                revoked = cursor.rowcount
            conn.commit()
        return access, identity, revoked

    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT payload FROM records WHERE domain = ? AND id = ?",
            ("agent_identities", identity_record_id),
        ).fetchone()
        if row is None:
            conn.rollback()
            return None, None, 0
        identity = json.loads(row["payload"])
        if identity.get("workspaceId") != workspace_id:
            conn.rollback()
            return None, None, 0
        aliases = {
            identity_id,
            str(identity.get("id", identity_id)),
            str(identity.get("agentId", identity_id)),
            str(access_payload.get("agentId", identity_id)),
        }
        pending_rows = conn.execute(
            "SELECT id, payload FROM records WHERE domain = ?",
            ("agent_access_requests",),
        ).fetchall()
        identity, access = apply_request_state(identity)
        for sibling_row in pending_rows:
            sibling = json.loads(sibling_row["payload"])
            if (
                sibling.get("workspaceId") == workspace_id
                and sibling.get("agentId") in aliases
                and sibling.get("status") == "pending_review"
            ):
                sibling = supersede(sibling)
                conn.execute(
                    "UPDATE records SET payload = ?, updated_at = CURRENT_TIMESTAMP WHERE domain = ? AND id = ?",
                    (json.dumps(sibling, separators=(",", ":")), "agent_access_requests", sibling_row["id"]),
                )
        conn.execute(
            "INSERT INTO records(domain, id, payload, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)",
            ("agent_access_requests", access_record_id, json.dumps(access, separators=(",", ":"))),
        )
        conn.execute(
            "UPDATE records SET payload = ?, updated_at = CURRENT_TIMESTAMP WHERE domain = ? AND id = ?",
            (json.dumps(identity, separators=(",", ":")), "agent_identities", identity_record_id),
        )
        revoked = 0
        lease_rows = conn.execute(
            "SELECT id, payload FROM records WHERE domain = ?",
            ("agent_authorization_leases",),
        ).fetchall()
        for lease_row in lease_rows:
            lease = json.loads(lease_row["payload"])
            if (
                lease.get("workspaceId") == workspace_id
                and lease.get("identityId") in aliases
                and lease.get("environment") == "prod"
                and lease.get("status") == "active"
            ):
                lease.update(status="revoked", revokedAt=now_iso, revokeReason=revoke_reason)
                conn.execute(
                    "UPDATE records SET payload = ?, updated_at = CURRENT_TIMESTAMP WHERE domain = ? AND id = ?",
                    (json.dumps(lease, separators=(",", ":")), "agent_authorization_leases", lease_row["id"]),
                )
                revoked += 1
        conn.commit()
        return access, identity, revoked


def decide_agent_approval_atomic(
    *,
    workspace_id: str,
    approval_record_id: str,
    expected_status: str,
    new_status: str,
    decision_patch: dict[str, Any],
    revoke_reason: str,
) -> tuple[dict[str, Any] | None, int]:
    """CAS an approval decision and revoke its leases in the same transaction."""
    updates = {**decision_patch, "status": new_status}

    if POSTGRES_URL:
        with postgres_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    f"""
                    UPDATE {pg_table()}
                    SET payload = payload || %s::jsonb, updated_at = now()
                    WHERE domain = 'agent_approvals' AND id = %s
                      AND payload->>'workspaceId' = %s
                      AND payload->>'status' = %s
                    RETURNING payload
                    """,
                    (
                        json.dumps(updates, separators=(",", ":")),
                        approval_record_id,
                        workspace_id,
                        expected_status,
                    ),
                )
                row = cursor.fetchone()
                if row is None:
                    conn.rollback()
                    return None, 0
                approval = normalize_payload(row[0])
                revoked = 0
                if new_status in {"blocked", "revoked"}:
                    lease_patch = {
                        "status": "revoked",
                        "revokedAt": decision_patch["reviewedAt"],
                        "revokeReason": revoke_reason,
                    }
                    cursor.execute(
                        f"""
                        UPDATE {pg_table()}
                        SET payload = payload || %s::jsonb, updated_at = now()
                        WHERE domain = 'agent_authorization_leases'
                          AND payload->>'workspaceId' = %s
                          AND payload->>'approvalId' = %s
                          AND payload->>'status' = 'active'
                        """,
                        (
                            json.dumps(lease_patch, separators=(",", ":")),
                            workspace_id,
                            str(approval["id"]),
                        ),
                    )
                    revoked = cursor.rowcount
            conn.commit()
        return approval, revoked

    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT payload FROM records WHERE domain = ? AND id = ?",
            ("agent_approvals", approval_record_id),
        ).fetchone()
        if row is None:
            conn.rollback()
            return None, 0
        approval = json.loads(row["payload"])
        if approval.get("workspaceId") != workspace_id or approval.get("status") != expected_status:
            conn.rollback()
            return None, 0
        approval.update(updates)
        conn.execute(
            "UPDATE records SET payload = ?, updated_at = CURRENT_TIMESTAMP WHERE domain = ? AND id = ?",
            (
                json.dumps(approval, separators=(",", ":")),
                "agent_approvals",
                approval_record_id,
            ),
        )
        revoked = 0
        if new_status in {"blocked", "revoked"}:
            lease_rows = conn.execute(
                "SELECT id, payload FROM records WHERE domain = ?",
                ("agent_authorization_leases",),
            ).fetchall()
            for lease_row in lease_rows:
                lease = json.loads(lease_row["payload"])
                if (
                    lease.get("workspaceId") == workspace_id
                    and lease.get("approvalId") == approval.get("id")
                    and lease.get("status") == "active"
                ):
                    lease.update(
                        status="revoked",
                        revokedAt=decision_patch["reviewedAt"],
                        revokeReason=revoke_reason,
                    )
                    conn.execute(
                        "UPDATE records SET payload = ?, updated_at = CURRENT_TIMESTAMP WHERE domain = ? AND id = ?",
                        (
                            json.dumps(lease, separators=(",", ":")),
                            "agent_authorization_leases",
                            lease_row["id"],
                        ),
                    )
                    revoked += 1
        conn.commit()
        return approval, revoked


def decide_agent_production_access_atomic(
    *,
    workspace_id: str,
    access_record_id: str,
    identity_record_id: str,
    identity_id: str,
    expected_status: str,
    new_status: str,
    access_patch: dict[str, Any],
    revoke_reason: str,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None, int]:
    """Commit only the current access decision and its identity effects together.

    Production access is identity-scoped rather than request-scoped.  The
    identity row serializes concurrent reviewers; once locked, only the newest
    request generation may decide posture and all older pending siblings are
    made non-actionable in the same transaction.
    """
    access_updates = {**access_patch, "status": new_status}
    identity_status = new_status
    now_iso = str(access_patch["reviewedAt"])
    identity_updates: dict[str, Any] = {
        "productionAccessStatus": identity_status,
        "lastApprovedAt": now_iso if new_status == "approved" else None,
        "updatedAt": now_iso,
    }

    def request_order(payload: dict[str, Any]) -> tuple[str, str]:
        return str(payload.get("createdAt", "")), str(payload.get("id", ""))

    def is_same_identity(payload: dict[str, Any], identity: dict[str, Any]) -> bool:
        return (
            payload.get("workspaceId") == workspace_id
            and payload.get("agentId") in {identity_id, identity.get("agentId")}
        )

    def supersede_pending(payload: dict[str, Any]) -> dict[str, Any]:
        payload.update(
            status="revoked",
            decision="block",
            reviewedAt=now_iso,
            reason=f"Superseded by production access decision {access_patch.get('reviewedBy', 'reviewer')}",
        )
        return payload

    if POSTGRES_URL:
        with postgres_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    f"SELECT payload FROM {pg_table()} WHERE domain = %s AND id = %s FOR UPDATE",
                    ("agent_identities", identity_record_id),
                )
                identity_row = cursor.fetchone()
                if identity_row is None:
                    conn.rollback()
                    return None, None, 0
                identity = normalize_payload(identity_row[0])
                cursor.execute(
                    f"""
                    SELECT id, payload FROM {pg_table()}
                    WHERE domain = 'agent_access_requests'
                      AND payload->>'workspaceId' = %s
                      AND payload->>'agentId' IN (%s, %s)
                    FOR UPDATE
                    """,
                    (workspace_id, identity_id, str(identity.get("agentId", identity_id))),
                )
                access_rows = cursor.fetchall()
                related = [(str(record_id), normalize_payload(payload)) for record_id, payload in access_rows]
                selected = next((payload for record_id, payload in related if record_id == access_record_id), None)
                if selected is None or not related:
                    conn.rollback()
                    return None, None, 0
                access = selected
                current_access = max((payload for _, payload in related), key=request_order)
                if (
                    access.get("workspaceId") != workspace_id
                    or identity.get("workspaceId") != workspace_id
                    or not is_same_identity(access, identity)
                    or access.get("status") != expected_status
                    or access.get("id") != current_access.get("id")
                ):
                    conn.rollback()
                    return None, None, 0
                access.update(access_updates)
                identity.update(identity_updates)
                cursor.execute(
                    f"UPDATE {pg_table()} SET payload = %s::jsonb, updated_at = now() WHERE domain = %s AND id = %s",
                    (json.dumps(access, separators=(",", ":")), "agent_access_requests", access_record_id),
                )
                for sibling_record_id, sibling in related:
                    if sibling_record_id != access_record_id and sibling.get("status") == "pending_review":
                        supersede_pending(sibling)
                        cursor.execute(
                            f"UPDATE {pg_table()} SET payload = %s::jsonb, updated_at = now() WHERE domain = %s AND id = %s",
                            (json.dumps(sibling, separators=(",", ":")), "agent_access_requests", sibling_record_id),
                        )
                cursor.execute(
                    f"UPDATE {pg_table()} SET payload = %s::jsonb, updated_at = now() WHERE domain = %s AND id = %s",
                    (json.dumps(identity, separators=(",", ":")), "agent_identities", identity_record_id),
                )
                revoked = 0
                if new_status != "approved":
                    lease_patch = {
                        "status": "revoked",
                        "revokedAt": now_iso,
                        "revokeReason": revoke_reason,
                    }
                    cursor.execute(
                        f"""
                        UPDATE {pg_table()} SET payload = payload || %s::jsonb, updated_at = now()
                        WHERE domain = 'agent_authorization_leases'
                          AND payload->>'workspaceId' = %s
                          AND payload->>'identityId' = %s
                          AND payload->>'environment' = 'prod'
                          AND payload->>'status' = 'active'
                        """,
                        (json.dumps(lease_patch, separators=(",", ":")), workspace_id, identity_id),
                    )
                    revoked = cursor.rowcount
            conn.commit()
        return access, identity, revoked

    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        identity_row = conn.execute(
            "SELECT payload FROM records WHERE domain = ? AND id = ?",
            ("agent_identities", identity_record_id),
        ).fetchone()
        if identity_row is None:
            conn.rollback()
            return None, None, 0
        identity = json.loads(identity_row["payload"])
        access_rows = conn.execute(
            "SELECT id, payload FROM records WHERE domain = ?",
            ("agent_access_requests",),
        ).fetchall()
        related = [
            (str(row["id"]), json.loads(row["payload"]))
            for row in access_rows
            if is_same_identity(json.loads(row["payload"]), identity)
        ]
        selected = next((payload for record_id, payload in related if record_id == access_record_id), None)
        if selected is None or not related:
            conn.rollback()
            return None, None, 0
        access = selected
        current_access = max((payload for _, payload in related), key=request_order)
        if (
            access.get("workspaceId") != workspace_id
            or identity.get("workspaceId") != workspace_id
            or not is_same_identity(access, identity)
            or access.get("status") != expected_status
            or access.get("id") != current_access.get("id")
        ):
            conn.rollback()
            return None, None, 0
        access.update(access_updates)
        identity.update(identity_updates)
        conn.execute(
            "UPDATE records SET payload = ?, updated_at = CURRENT_TIMESTAMP WHERE domain = ? AND id = ?",
            (json.dumps(access, separators=(",", ":")), "agent_access_requests", access_record_id),
        )
        for sibling_record_id, sibling in related:
            if sibling_record_id != access_record_id and sibling.get("status") == "pending_review":
                supersede_pending(sibling)
                conn.execute(
                    "UPDATE records SET payload = ?, updated_at = CURRENT_TIMESTAMP WHERE domain = ? AND id = ?",
                    (
                        json.dumps(sibling, separators=(",", ":")),
                        "agent_access_requests",
                        sibling_record_id,
                    ),
                )
        conn.execute(
            "UPDATE records SET payload = ?, updated_at = CURRENT_TIMESTAMP WHERE domain = ? AND id = ?",
            (json.dumps(identity, separators=(",", ":")), "agent_identities", identity_record_id),
        )
        revoked = 0
        if new_status != "approved":
            rows = conn.execute(
                "SELECT id, payload FROM records WHERE domain = ?",
                ("agent_authorization_leases",),
            ).fetchall()
            for row in rows:
                lease = json.loads(row["payload"])
                if (
                    lease.get("workspaceId") == workspace_id
                    and lease.get("identityId") == identity_id
                    and lease.get("environment") == "prod"
                    and lease.get("status") == "active"
                ):
                    lease.update(status="revoked", revokedAt=now_iso, revokeReason=revoke_reason)
                    conn.execute(
                        "UPDATE records SET payload = ?, updated_at = CURRENT_TIMESTAMP WHERE domain = ? AND id = ?",
                        (
                            json.dumps(lease, separators=(",", ":")),
                            "agent_authorization_leases",
                            row["id"],
                        ),
                    )
                    revoked += 1
        conn.commit()
        return access, identity, revoked


def update_record(domain: str, record_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
    payload = get_record(domain, record_id)
    if payload is None:
        return None
    payload.update({key: value for key, value in patch.items() if value is not None})
    return save_record(domain, record_id, payload)


def compare_and_set_record_status(
    domain: str,
    record_id: str,
    expected_status: str,
    new_status: str,
    patch: dict[str, Any] | None = None,
    *,
    workspace_id: str | None = None,
) -> dict[str, Any] | None:
    """Atomically transition a JSON record status and return the new payload.

    A workspace predicate is part of the mutation when supplied, preventing a
    caller from using a valid record id to transition another workspace's row.
    """
    updates = {**(patch or {}), "status": new_status}
    if POSTGRES_URL:
        workspace_sql = "AND payload->>'workspaceId' = %s" if workspace_id is not None else ""
        params: list[Any] = [json.dumps(updates, separators=(",", ":")), domain, record_id, expected_status]
        if workspace_id is not None:
            params.append(workspace_id)
        with postgres_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    f"""
                    UPDATE {pg_table()}
                    SET payload = payload || %s::jsonb, updated_at = now()
                    WHERE domain = %s AND id = %s
                      AND payload->>'status' = %s
                      {workspace_sql}
                    RETURNING payload
                    """,
                    tuple(params),
                )
                row = cursor.fetchone()
            conn.commit()
        return normalize_payload(row[0]) if row else None

    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT payload FROM records WHERE domain = ? AND id = ?",
            (domain, record_id),
        ).fetchone()
        if row is None:
            return None
        payload = json.loads(row["payload"])
        if payload.get("status") != expected_status:
            return None
        if workspace_id is not None and payload.get("workspaceId") != workspace_id:
            return None
        payload.update(updates)
        conn.execute(
            "UPDATE records SET payload = ?, updated_at = CURRENT_TIMESTAMP WHERE domain = ? AND id = ?",
            (json.dumps(payload, separators=(",", ":")), domain, record_id),
        )
        conn.commit()
        return payload


def transition_record_and_insert(
    transition_domain: str,
    transition_id: str,
    expected_status: str,
    new_status: str,
    transition_patch: dict[str, Any],
    insert_domain: str,
    insert_id: str,
    insert_payload: dict[str, Any],
    *,
    workspace_id: str,
) -> dict[str, Any] | None:
    """Atomically transition one workspace record and insert another.

    Returning ``None`` means the transition predicate lost a race (or did not
    belong to the workspace); in that case no inserted record is committed.
    """
    updates = {**transition_patch, "status": new_status}
    if insert_payload.get("workspaceId") != workspace_id:
        raise ValueError("Inserted record must be bound to the transaction workspace")

    if POSTGRES_URL:
        with postgres_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    f"""
                    UPDATE {pg_table()}
                    SET payload = payload || %s::jsonb, updated_at = now()
                    WHERE domain = %s AND id = %s
                      AND payload->>'status' = %s
                      AND payload->>'workspaceId' = %s
                    RETURNING payload
                    """,
                    (
                        json.dumps(updates, separators=(",", ":")),
                        transition_domain,
                        transition_id,
                        expected_status,
                        workspace_id,
                    ),
                )
                row = cursor.fetchone()
                if row is None:
                    conn.rollback()
                    return None
                cursor.execute(
                    f"INSERT INTO {pg_table()} (domain, id, payload) VALUES (%s, %s, %s::jsonb)",
                    (
                        insert_domain,
                        insert_id,
                        json.dumps(insert_payload, separators=(",", ":")),
                    ),
                )
            conn.commit()
        return normalize_payload(row[0])

    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT payload FROM records WHERE domain = ? AND id = ?",
            (transition_domain, transition_id),
        ).fetchone()
        if row is None:
            conn.rollback()
            return None
        payload = json.loads(row["payload"])
        if payload.get("status") != expected_status or payload.get("workspaceId") != workspace_id:
            conn.rollback()
            return None
        payload.update(updates)
        conn.execute(
            "UPDATE records SET payload = ?, updated_at = CURRENT_TIMESTAMP WHERE domain = ? AND id = ?",
            (
                json.dumps(payload, separators=(",", ":")),
                transition_domain,
                transition_id,
            ),
        )
        conn.execute(
            """
            INSERT INTO records(domain, id, payload, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            """,
            (
                insert_domain,
                insert_id,
                json.dumps(insert_payload, separators=(",", ":")),
            ),
        )
        conn.commit()
        return payload


def issue_agent_authorization_lease(
    *,
    workspace_id: str,
    identity_record_id: str,
    credential_hash: str,
    required_permission: str,
    provider: str,
    environment: str,
    idempotency_key: str,
    lease_record_id: str,
    lease_payload: dict[str, Any],
    approval_record_id: str | None = None,
    approval_binding_hash: str | None = None,
    now_iso: str,
) -> dict[str, Any]:
    """Validate current agent authority and insert its lease in one transaction.

    The identity row is the serialization point shared with every lifecycle
    mutation.  Postgres additionally locks a bound approval row.  The returned
    ``status`` is a stable domain result so HTTP policy stays outside storage.
    """
    if lease_payload.get("workspaceId") != workspace_id:
        raise ValueError("Lease must be bound to the transaction workspace")

    def validate_identity(payload: dict[str, Any]) -> str | None:
        if payload.get("workspaceId") != workspace_id:
            return "identity_missing"
        if payload.get("credentialStatus") != "active" or payload.get("credentialHash") != credential_hash:
            return "credential_invalid"
        if payload.get("status") in {"disabled", "revoked"}:
            return "identity_disabled"
        if required_permission not in payload.get("permissions", []):
            return "permission_denied"
        if provider not in payload.get("providerAccess", []):
            return "provider_denied"
        configured_environment = payload.get("environment", "staging")
        if configured_environment not in {"all", environment}:
            return "environment_denied"
        if environment == "prod" and payload.get("productionAccessStatus") != "approved":
            return "production_denied"
        return None

    def validate_approval(payload: dict[str, Any] | None) -> str | None:
        if approval_record_id is None:
            return None
        if payload is None or payload.get("workspaceId") != workspace_id:
            return "approval_invalid"
        if (
            payload.get("identityId") != lease_payload.get("identityId")
            or payload.get("idempotencyKey") != idempotency_key
            or payload.get("bindingHash", payload.get("contentHash")) != approval_binding_hash
        ):
            return "approval_invalid"
        if payload.get("status") != "approved":
            return "approval_unavailable"
        if str(payload.get("expiresAt", "")) <= now_iso:
            return "approval_expired"
        return None

    binding_fields = (
        "identityId",
        "action",
        "toolCategory",
        "operation",
        "contextHash",
        "contentHash",
        "provider",
        "model",
        "environment",
        "risk",
        "idempotencyKey",
        "approvalId",
    )

    def replay_result(payload: dict[str, Any] | None) -> dict[str, Any] | None:
        if payload is None:
            return None
        if any(payload.get(field) != lease_payload.get(field) for field in binding_fields):
            return {"status": "lease_exists"}
        if payload.get("status") != "active" or str(payload.get("expiresAt", "")) <= now_iso:
            return {"status": "lease_exists"}
        return {"status": "replayed", "lease": payload}

    if POSTGRES_URL:
        with postgres_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    f"SELECT payload FROM {pg_table()} WHERE domain = %s AND id = %s FOR UPDATE",
                    ("agent_identities", identity_record_id),
                )
                row = cursor.fetchone()
                identity = normalize_payload(row[0]) if row else None
                failure = "identity_missing" if identity is None else validate_identity(identity)
                if failure:
                    conn.rollback()
                    return {"status": failure}
                cursor.execute(
                    f"""
                    SELECT payload FROM {pg_table()}
                    WHERE domain = 'agent_authorization_leases'
                      AND payload->>'workspaceId' = %s
                      AND payload->>'identityId' = %s
                      AND payload->>'idempotencyKey' = %s
                    LIMIT 1
                    """,
                    (workspace_id, lease_payload["identityId"], idempotency_key),
                )
                existing_row = cursor.fetchone()
                replay = replay_result(normalize_payload(existing_row[0]) if existing_row else None)
                if replay is not None:
                    conn.rollback()
                    return replay
                approval = None
                if approval_record_id is not None:
                    cursor.execute(
                        f"SELECT payload FROM {pg_table()} WHERE domain = %s AND id = %s FOR UPDATE",
                        ("agent_approvals", approval_record_id),
                    )
                    approval_row = cursor.fetchone()
                    approval = normalize_payload(approval_row[0]) if approval_row else None
                    failure = validate_approval(approval)
                    if failure:
                        conn.rollback()
                        return {"status": failure}
                    approval = {**approval, "status": "consumed", "consumedAt": now_iso}
                    cursor.execute(
                        f"UPDATE {pg_table()} SET payload = %s::jsonb, updated_at = now() WHERE domain = %s AND id = %s",
                        (json.dumps(approval, separators=(",", ":")), "agent_approvals", approval_record_id),
                    )
                cursor.execute(
                    f"INSERT INTO {pg_table()} (domain, id, payload) VALUES (%s, %s, %s::jsonb)",
                    ("agent_authorization_leases", lease_record_id, json.dumps(lease_payload, separators=(",", ":"))),
                )
            conn.commit()
        return {"status": "issued", "identity": identity, "approval": approval}

    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT payload FROM records WHERE domain = ? AND id = ?",
            ("agent_identities", identity_record_id),
        ).fetchone()
        identity = json.loads(row["payload"]) if row else None
        failure = "identity_missing" if identity is None else validate_identity(identity)
        if failure:
            conn.rollback()
            return {"status": failure}
        rows = conn.execute(
            "SELECT payload FROM records WHERE domain = ?",
            ("agent_authorization_leases",),
        ).fetchall()
        existing = next(
            (
                candidate
                for item in rows
                if (candidate := json.loads(item["payload"])).get("workspaceId") == workspace_id
                and candidate.get("identityId") == lease_payload["identityId"]
                and candidate.get("idempotencyKey") == idempotency_key
            ),
            None,
        )
        replay = replay_result(existing)
        if replay is not None:
            conn.rollback()
            return replay
        approval = None
        if approval_record_id is not None:
            approval_row = conn.execute(
                "SELECT payload FROM records WHERE domain = ? AND id = ?",
                ("agent_approvals", approval_record_id),
            ).fetchone()
            approval = json.loads(approval_row["payload"]) if approval_row else None
            failure = validate_approval(approval)
            if failure:
                conn.rollback()
                return {"status": failure}
            approval = {**approval, "status": "consumed", "consumedAt": now_iso}
            conn.execute(
                "UPDATE records SET payload = ?, updated_at = CURRENT_TIMESTAMP WHERE domain = ? AND id = ?",
                (json.dumps(approval, separators=(",", ":")), "agent_approvals", approval_record_id),
            )
        conn.execute(
            "INSERT INTO records(domain, id, payload, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)",
            ("agent_authorization_leases", lease_record_id, json.dumps(lease_payload, separators=(",", ":"))),
        )
        conn.commit()
        return {"status": "issued", "identity": identity, "approval": approval}


def mutate_agent_identity_and_revoke_leases(
    *,
    workspace_id: str,
    identity_record_id: str,
    identity_id: str,
    identity_patch: dict[str, Any],
    reason: str,
    lease_environment: str | None = None,
    lifecycle_action: str = "boundary_update",
    credential_hash: str | None = None,
    credential_preview: str | None = None,
    initial_identity: dict[str, Any] | None = None,
) -> tuple[dict[str, Any] | None, int]:
    """Serialize a minimal identity delta against lease issuance.

    Callers never supply a previously read identity snapshot.  The current
    record is loaded under the transaction lock, then only the intended public
    boundary fields and explicit lifecycle effects are applied.  This prevents
    a concurrent boundary change from restoring a stale credential hash.
    """
    protected_fields = {
        "id",
        "agentId",
        "workspaceId",
        "createdAt",
        "updatedAt",
        "credentialHash",
        "credentialPreview",
        "credentialStatus",
        "credentialRotatedAt",
        "status",
        "killSwitchReason",
        "productionAccessStatus",
        "lastApprovedAt",
    }
    unexpected = protected_fields.intersection(identity_patch)
    if unexpected:
        raise ValueError(f"Lifecycle-managed identity fields cannot be patched directly: {sorted(unexpected)}")
    if lifecycle_action == "rotate" and (credential_hash is None or credential_preview is None):
        raise ValueError("Credential rotation requires a hash and preview")
    if initial_identity is not None and initial_identity.get("workspaceId") != workspace_id:
        raise ValueError("Initial identity must be bound to the transaction workspace")

    def apply_mutation(identity: dict[str, Any]) -> tuple[dict[str, Any], str]:
        now_iso = datetime.now().isoformat()
        identity.update(identity_patch)
        if lifecycle_action == "rotate":
            identity.update(
                credentialHash=credential_hash,
                credentialPreview=credential_preview,
                credentialStatus="active",
                credentialRotatedAt=now_iso,
            )
        elif lifecycle_action == "revoke":
            identity.update(status="revoked", credentialStatus="revoked", killSwitchReason=reason)
        elif lifecycle_action == "kill_switch":
            identity.update(status="disabled", killSwitchReason=reason)
        elif lifecycle_action == "production_request":
            identity["productionAccessStatus"] = (
                "blocked" if identity.get("status") in {"disabled", "revoked"} else "pending_review"
            )
        elif lifecycle_action == "production_approved":
            identity.update(productionAccessStatus="approved", lastApprovedAt=now_iso)
        elif lifecycle_action in {"production_blocked", "production_revoked"}:
            identity.update(
                productionAccessStatus=lifecycle_action.removeprefix("production_"),
                lastApprovedAt=None,
            )
        identity["updatedAt"] = now_iso
        return identity, now_iso

    if POSTGRES_URL:
        with postgres_connection() as conn:
            with conn.cursor() as cursor:
                if initial_identity is not None:
                    cursor.execute(
                        f"""
                        INSERT INTO {pg_table()} (domain, id, payload)
                        VALUES (%s, %s, %s::jsonb)
                        ON CONFLICT (domain, id) DO NOTHING
                        """,
                        (
                            "agent_identities",
                            identity_record_id,
                            json.dumps(initial_identity, separators=(",", ":")),
                        ),
                    )
                cursor.execute(
                    f"SELECT payload FROM {pg_table()} WHERE domain = %s AND id = %s FOR UPDATE",
                    ("agent_identities", identity_record_id),
                )
                row = cursor.fetchone()
                if row is None:
                    conn.rollback()
                    return None, 0
                identity = normalize_payload(row[0])
                if identity.get("workspaceId") != workspace_id:
                    conn.rollback()
                    return None, 0
                identity, mutation_time = apply_mutation(identity)
                lease_identity_id = str(identity.get("id") or identity_id)
                lease_patch = {"status": "revoked", "revokedAt": mutation_time, "revokeReason": reason}
                cursor.execute(
                    f"UPDATE {pg_table()} SET payload = %s::jsonb, updated_at = now() WHERE domain = %s AND id = %s",
                    (json.dumps(identity, separators=(",", ":")), "agent_identities", identity_record_id),
                )
                environment_sql = "AND payload->>'environment' = %s" if lease_environment else ""
                params: list[Any] = [json.dumps(lease_patch, separators=(",", ":")), workspace_id, lease_identity_id]
                if lease_environment:
                    params.append(lease_environment)
                cursor.execute(
                    f"""
                    UPDATE {pg_table()} SET payload = payload || %s::jsonb, updated_at = now()
                    WHERE domain = 'agent_authorization_leases'
                      AND payload->>'workspaceId' = %s AND payload->>'identityId' = %s
                      AND payload->>'status' = 'active' {environment_sql}
                    """,
                    tuple(params),
                )
                revoked = cursor.rowcount
            conn.commit()
        return identity, revoked

    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        if initial_identity is not None:
            conn.execute(
                """
                INSERT OR IGNORE INTO records(domain, id, payload, updated_at)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                """,
                (
                    "agent_identities",
                    identity_record_id,
                    json.dumps(initial_identity, separators=(",", ":")),
                ),
            )
        row = conn.execute(
            "SELECT payload FROM records WHERE domain = ? AND id = ?",
            ("agent_identities", identity_record_id),
        ).fetchone()
        if row is None:
            conn.rollback()
            return None, 0
        identity = json.loads(row["payload"])
        if identity.get("workspaceId") != workspace_id:
            conn.rollback()
            return None, 0
        identity, mutation_time = apply_mutation(identity)
        lease_identity_id = str(identity.get("id") or identity_id)
        lease_patch = {"status": "revoked", "revokedAt": mutation_time, "revokeReason": reason}
        conn.execute(
            "UPDATE records SET payload = ?, updated_at = CURRENT_TIMESTAMP WHERE domain = ? AND id = ?",
            (json.dumps(identity, separators=(",", ":")), "agent_identities", identity_record_id),
        )
        revoked = 0
        rows = conn.execute(
            "SELECT id, payload FROM records WHERE domain = ?",
            ("agent_authorization_leases",),
        ).fetchall()
        for lease_row in rows:
            lease = json.loads(lease_row["payload"])
            if (
                lease.get("workspaceId") == workspace_id
                and lease.get("identityId") == lease_identity_id
                and lease.get("status") == "active"
                and (lease_environment is None or lease.get("environment") == lease_environment)
            ):
                lease.update(lease_patch)
                conn.execute(
                    "UPDATE records SET payload = ?, updated_at = CURRENT_TIMESTAMP WHERE domain = ? AND id = ?",
                    (json.dumps(lease, separators=(",", ":")), "agent_authorization_leases", lease_row["id"]),
                )
                revoked += 1
        conn.commit()
        return identity, revoked


def delete_record(domain: str, record_id: str) -> None:
    if POSTGRES_URL:
        with postgres_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute(f"DELETE FROM {pg_table()} WHERE domain = %s AND id = %s", (domain, record_id))
            conn.commit()
        return
    with connect() as conn:
        conn.execute("DELETE FROM records WHERE domain = ? AND id = ?", (domain, record_id))
        conn.commit()


def insert_sqlite(conn: sqlite3.Connection, domain: str, record_id: str, payload: dict[str, Any]) -> None:
    conn.execute(
        """
        INSERT OR REPLACE INTO records(domain, id, payload, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        """,
        (domain, record_id, json.dumps(payload, separators=(",", ":"))),
    )


def postgres_connection():
    try:
        import psycopg
    except ImportError as exc:
        raise RuntimeError("Postgres storage requires installing psycopg[binary]. Run: python -m pip install -r backend/requirements.txt") from exc

    if not POSTGRES_URL:
        raise RuntimeError("Postgres storage requested without NEURALOPS_DATABASE_URL, SUPABASE_DB_URL, or DATABASE_URL.")
    return psycopg.connect(POSTGRES_URL, **database_connection_options())


def pg_table() -> str:
    return f"{quote_ident(POSTGRES_SCHEMA)}.{quote_ident(POSTGRES_TABLE)}"


def quote_ident(value: str) -> str:
    if not value.replace("_", "").isalnum():
        raise ValueError(f"Unsafe SQL identifier: {value}")
    return f'"{value}"'


def normalize_payload(payload: Any) -> dict[str, Any]:
    if isinstance(payload, dict):
        return payload
    if isinstance(payload, str):
        return json.loads(payload)
    return dict(payload)
