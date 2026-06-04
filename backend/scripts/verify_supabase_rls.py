from __future__ import annotations

from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.config import load_local_env  # noqa: E402
from app import database  # noqa: E402


EXPECTED_POLICIES = {
    "records_workspace_delete": "DELETE",
    "records_workspace_insert": "INSERT",
    "records_workspace_select": "SELECT",
    "records_workspace_update": "UPDATE",
}

EXPECTED_FUNCTIONS = {"current_workspace_id", "record_workspace_id"}


def main() -> None:
    load_local_env()
    if database.storage_backend() != "postgres":
        raise SystemExit("NEURALOPS_DATABASE_URL, SUPABASE_DB_URL, or DATABASE_URL is required for RLS verification.")

    with database.postgres_connection() as conn:
        with conn.cursor() as cursor:
            cursor.execute(
                """
                select c.relrowsecurity
                from pg_class c
                join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = %s and c.relname = %s
                """,
                (database.POSTGRES_SCHEMA, database.POSTGRES_TABLE),
            )
            table = cursor.fetchone()
            if table is None:
                raise SystemExit(f"Missing table {database.POSTGRES_SCHEMA}.{database.POSTGRES_TABLE}.")
            if table[0] is not True:
                raise SystemExit("RLS is not enabled on the NeuralOps records table.")

            cursor.execute(
                """
                select policyname, cmd
                from pg_policies
                where schemaname = %s and tablename = %s
                """,
                (database.POSTGRES_SCHEMA, database.POSTGRES_TABLE),
            )
            policies = {name: cmd for name, cmd in cursor.fetchall()}
            missing = {name: cmd for name, cmd in EXPECTED_POLICIES.items() if policies.get(name) != cmd}
            if missing:
                raise SystemExit(f"Missing or mismatched RLS policies: {', '.join(sorted(missing))}.")

            cursor.execute(
                """
                select routine_name
                from information_schema.routines
                where specific_schema = %s
                  and routine_name in ('current_workspace_id', 'record_workspace_id')
                """,
                (database.POSTGRES_SCHEMA,),
            )
            functions = {row[0] for row in cursor.fetchall()}
            missing_functions = EXPECTED_FUNCTIONS - functions
            if missing_functions:
                raise SystemExit(f"Missing RLS helper functions: {', '.join(sorted(missing_functions))}.")

    print(f"rls_verified={database.POSTGRES_SCHEMA}.{database.POSTGRES_TABLE}")


if __name__ == "__main__":
    main()
