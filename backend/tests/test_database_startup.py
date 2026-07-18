from __future__ import annotations

import sys
import asyncio
from threading import Event
from types import SimpleNamespace

from app import database
from app import main


class _Cursor:
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def execute(self, statement: str) -> None:
        assert statement == "SELECT 1"

    def fetchone(self):
        return (1,)


class _Connection:
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def cursor(self):
        return _Cursor()


def test_postgres_connections_have_bounded_connect_and_statement_timeouts(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def fake_connect(url: str, **kwargs):
        captured.update({"url": url, **kwargs})
        return _Connection()

    monkeypatch.setattr(database, "POSTGRES_URL", "postgresql://example.invalid/neuralops")
    monkeypatch.setenv("NEURALOPS_DB_CONNECT_TIMEOUT_SECONDS", "4")
    monkeypatch.setenv("NEURALOPS_DB_STATEMENT_TIMEOUT_MS", "12000")
    monkeypatch.setitem(sys.modules, "psycopg", SimpleNamespace(connect=fake_connect))

    assert database.probe_database() is True
    assert captured == {
        "url": "postgresql://example.invalid/neuralops",
        "connect_timeout": 4,
        "options": "-c statement_timeout=12000",
    }


def test_postgres_lifespan_does_not_block_process_startup(monkeypatch) -> None:
    started = Event()
    release = Event()

    def delayed_init() -> None:
        started.set()
        release.wait(timeout=2)

    monkeypatch.setattr(main, "storage_backend", lambda: "postgres")
    monkeypatch.setattr(main, "initialize_database", delayed_init)

    async def verify() -> None:
        async with main.lifespan(None):
            await asyncio.to_thread(started.wait, 1)
            assert main.STARTUP_STATE["status"] == "checking"
            release.set()

    asyncio.run(verify())
