from __future__ import annotations

import json
import os
import sqlite3
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


def storage_backend() -> str:
    return "postgres" if POSTGRES_URL else "sqlite"


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
            cursor.execute(f"ALTER TABLE {pg_table()} ENABLE ROW LEVEL SECURITY")
        conn.commit()


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


def update_record(domain: str, record_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
    payload = get_record(domain, record_id)
    if payload is None:
        return None
    payload.update({key: value for key, value in patch.items() if value is not None})
    return save_record(domain, record_id, payload)


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
    return psycopg.connect(POSTGRES_URL)


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
