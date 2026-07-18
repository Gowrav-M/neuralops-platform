from __future__ import annotations

import os
from contextvars import ContextVar
from functools import lru_cache
from secrets import compare_digest
from typing import Any

from fastapi import HTTPException
from jwt import PyJWKClient, decode
from jwt.exceptions import InvalidTokenError


_current_claims: ContextVar[dict[str, Any] | None] = ContextVar("current_claims", default=None)
_requested_workspace_id: ContextVar[str | None] = ContextVar("requested_workspace_id", default=None)


def auth_required() -> bool:
    return os.getenv("NEURALOPS_AUTH_REQUIRED", "false").lower() in {"1", "true", "yes"}


def public_auth_paths() -> set[str]:
    return {
        "/health",
        "/ready",
        "/docs",
        "/openapi.json",
        "/redoc",
        "/api/public/pilot-applications",
    }


def set_current_claims(claims: dict[str, Any] | None):
    return _current_claims.set(claims)


def reset_current_claims(token) -> None:
    _current_claims.reset(token)


def set_requested_workspace_id(workspace_id: str | None):
    value = workspace_id.strip() if isinstance(workspace_id, str) and workspace_id.strip() else None
    return _requested_workspace_id.set(value)


def reset_requested_workspace_id(token) -> None:
    _requested_workspace_id.reset(token)


def current_claims() -> dict[str, Any] | None:
    return _current_claims.get()


def requested_workspace_id() -> str | None:
    return _requested_workspace_id.get()


def workspace_id_from_claims(claims: dict[str, Any] | None) -> str | None:
    if not claims:
        return None
    app_metadata = claims.get("app_metadata")
    if isinstance(app_metadata, dict):
        workspace_id = app_metadata.get("neuralops_workspace_id") or app_metadata.get("workspace_id")
        if isinstance(workspace_id, str) and workspace_id.strip():
            return workspace_id.strip()
    subject = claims.get("sub")
    if isinstance(subject, str) and subject.strip():
        return f"user-{subject.strip()}"
    return None


def verify_supabase_token(authorization: str | None) -> dict[str, Any]:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing Supabase bearer token")

    token = authorization[7:].strip()
    jwt_secret = os.getenv("SUPABASE_JWT_SECRET")
    try:
        if jwt_secret:
            return decode(token, jwt_secret, algorithms=["HS256"], options={"verify_aud": False})
        return verify_with_jwks(token)
    except InvalidTokenError as exc:
        raise HTTPException(status_code=401, detail="Invalid Supabase session token") from exc


def verify_request_claims(authorization: str | None, qa_token: str | None = None) -> dict[str, Any]:
    configured_qa_token = os.getenv("NEURALOPS_QA_AUTH_TOKEN", "").strip()
    if configured_qa_token and qa_token and compare_digest(qa_token, configured_qa_token):
        workspace_id = os.getenv("NEURALOPS_QA_WORKSPACE_ID", "deployed-qa-workspace").strip() or "deployed-qa-workspace"
        return {
            "sub": "neuralops-deployment-qa",
            "role": "authenticated",
            "app_metadata": {"neuralops_workspace_id": workspace_id},
        }
    return verify_supabase_token(authorization)


@lru_cache(maxsize=1)
def jwks_client() -> PyJWKClient:
    supabase_url = os.getenv("SUPABASE_URL") or os.getenv("VITE_SUPABASE_URL")
    if not supabase_url:
        raise HTTPException(status_code=500, detail="SUPABASE_URL is required when auth is enabled without SUPABASE_JWT_SECRET")
    return PyJWKClient(f"{supabase_url.rstrip('/')}/auth/v1/.well-known/jwks.json")


def verify_with_jwks(token: str) -> dict[str, Any]:
    signing_key = jwks_client().get_signing_key_from_jwt(token)
    return decode(
        token,
        signing_key.key,
        algorithms=["RS256", "ES256"],
        options={"verify_aud": False},
    )
