from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from . import seed

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "neuralops.sqlite3"


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
    backfill_seed_defaults()


def seed_if_empty() -> None:
    with connect() as conn:
        count = conn.execute("SELECT COUNT(*) FROM records").fetchone()[0]
        if count:
            return

        insert(conn, "stats", "current", seed.STATS)
        for trace in seed.TRACES:
            insert(conn, "traces", trace["id"], trace)
        for incident in seed.INCIDENTS:
            insert(conn, "incidents", incident["id"], incident)
        for prompt in seed.PROMPTS:
            insert(conn, "prompts", prompt["id"], prompt)
        for evaluator in seed.EVALS:
            insert(conn, "evals", evaluator["id"], evaluator)
        for rag_query in seed.RAG:
            insert(conn, "rag", rag_query["id"], rag_query)
        insert(conn, "costs", "current", seed.COSTS)
        for policy in seed.POLICIES:
            insert(conn, "policies", policy["id"], policy)
        for violation in seed.POLICY_VIOLATIONS:
            insert(conn, "policy_violations", violation["id"], violation)
        for agent in seed.AGENTS:
            insert(conn, "agents", agent["id"], agent)
        insert(conn, "settings", "current", seed.SETTINGS)
        conn.commit()


def backfill_seed_defaults() -> None:
    seed_records = {
        "prompts": seed.PROMPTS,
        "evals": seed.EVALS,
        "rag": seed.RAG,
        "policy_violations": seed.POLICY_VIOLATIONS,
    }
    with connect() as conn:
        for domain, records in seed_records.items():
            for seeded in records:
                row = conn.execute(
                    "SELECT payload FROM records WHERE domain = ? AND id = ?",
                    (domain, seeded["id"]),
                ).fetchone()
                if row is None:
                    insert(conn, domain, seeded["id"], seeded)
                    continue
                current = json.loads(row["payload"])
                merged = {**seeded, **current}
                for key, value in seeded.items():
                    if key not in current or current[key] in (None, "", []):
                        merged[key] = value
                insert(conn, domain, seeded["id"], merged)

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
