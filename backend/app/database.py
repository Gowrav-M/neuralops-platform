from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path
from typing import Any

from . import seed

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
DB_PATH = Path(os.getenv("NEURALOPS_DB_PATH", DATA_DIR / "neuralops.sqlite3"))


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
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
    seed_if_empty()
    cleanup_legacy_demo_records()


def seed_if_empty() -> None:
    with connect() as conn:
        count = conn.execute("SELECT COUNT(*) FROM records").fetchone()[0]
        if count:
            return

        for policy in seed.POLICIES:
            insert(conn, "policies", policy["id"], policy)
        insert(conn, "settings", "current", seed.SETTINGS)
        conn.commit()


def cleanup_legacy_demo_records() -> None:
    with connect() as conn:
        remove_known_fake_records(conn)
        clean_settings_artifacts(conn)
        settings_row = conn.execute(
            "SELECT payload FROM records WHERE domain = ? AND id = ?",
            ("settings", "current"),
        ).fetchone()
        if settings_row is not None:
            current_settings = json.loads(settings_row["payload"])
            for key in ("ssoStatus", "billingPlan", "nextInvoice"):
                if key not in current_settings:
                    current_settings[key] = seed.SETTINGS.get(key)
            for webhook in current_settings.get("webhooks", []):
                if webhook.get("url") == "https://hooks.slack.com/services/demo":
                    webhook["name"] = "Operations Alert Receiver"
                    webhook["url"] = "https://hooks.example.invalid/neuralops"
            insert(conn, "settings", "current", current_settings)
        conn.commit()


def remove_known_fake_records(conn: sqlite3.Connection) -> None:
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
        rows = conn.execute("SELECT id, payload FROM records WHERE domain = ?", (domain,)).fetchall()
        for row in rows:
            payload = json.loads(row["payload"])
            if is_fake_record(domain, row["id"], payload):
                conn.execute("DELETE FROM records WHERE domain = ? AND id = ?", (domain, row["id"]))


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


def clean_settings_artifacts(conn: sqlite3.Connection) -> None:
    row = conn.execute(
        "SELECT payload FROM records WHERE domain = ? AND id = ?",
        ("settings", "current"),
    ).fetchone()
    if row is None:
        return
    payload = json.loads(row["payload"])
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
    insert(conn, "settings", "current", payload)


def insert(conn: sqlite3.Connection, domain: str, record_id: str, payload: dict[str, Any]) -> None:
    conn.execute(
        """
        INSERT OR REPLACE INTO records(domain, id, payload, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        """,
        (domain, record_id, json.dumps(payload, separators=(",", ":"))),
    )


def list_records(domain: str) -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute("SELECT payload FROM records WHERE domain = ? ORDER BY id", (domain,)).fetchall()
    return [json.loads(row["payload"]) for row in rows]


def get_record(domain: str, record_id: str) -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute("SELECT payload FROM records WHERE domain = ? AND id = ?", (domain, record_id)).fetchone()
    return json.loads(row["payload"]) if row else None


def save_record(domain: str, record_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    with connect() as conn:
        insert(conn, domain, record_id, payload)
        conn.commit()
    return payload


def update_record(domain: str, record_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
    payload = get_record(domain, record_id)
    if payload is None:
        return None
    payload.update({key: value for key, value in patch.items() if value is not None})
    return save_record(domain, record_id, payload)
