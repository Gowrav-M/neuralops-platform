from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
from hashlib import sha1, sha256
from threading import Lock
from typing import Any

from .agent_runtime import run_agent
from .database import (
    cancel_agent_jobs_atomic,
    compare_and_set_record_status,
    list_domain_records_with_ids,
    save_record,
)
from .schemas import AgentJob, AgentJobProcessResponse, AgentJobSubmitRequest


_identity_locks_guard = Lock()
_identity_locks: dict[tuple[str, str], Lock] = {}


@contextmanager
def identity_execution_guard(workspace_id: str, identity_ids: set[str]):
    keys = sorted((workspace_id, value) for value in identity_ids if value)
    with _identity_locks_guard:
        locks = [_identity_locks.setdefault(key, Lock()) for key in keys]
    for lock in locks:
        lock.acquire()
    try:
        yield
    finally:
        for lock in reversed(locks):
            lock.release()


def cancel_jobs_for_identity(
    workspace_id: str,
    identity_ids: set[str],
    *,
    environment: str | None = None,
) -> int:
    return cancel_agent_jobs_atomic(
        workspace_id=workspace_id,
        identity_ids=identity_ids,
        now_iso=_now(),
        environment=environment,
    )


def submit_job(request: AgentJobSubmitRequest, workspace_id: str) -> AgentJob:
    now = _now()
    job = AgentJob(
        id=f"job_{_stable_id(workspace_id + request.agentId + request.input + now)[:12]}",
        workspaceId=workspace_id,
        status="queued",
        request=request,
        attempts=0,
        maxAttempts=request.maxAttempts,
        createdAt=now,
        updatedAt=now,
    )
    save_record("agent_jobs", _record_id(workspace_id, job.id), job.model_dump())
    return job


def list_jobs(workspace_id: str, limit: int = 25) -> list[AgentJob]:
    jobs: list[AgentJob] = []
    for record in list_domain_records_with_ids("agent_jobs"):
        payload = record["payload"]
        if payload.get("workspaceId") != workspace_id:
            continue
        try:
            jobs.append(AgentJob.model_validate(payload))
        except ValueError:
            # Malformed and legacy records are not safe to expose or execute.
            continue
    jobs.sort(key=lambda item: item.createdAt, reverse=True)
    return jobs[:limit]


def _job_record(workspace_id: str, job_id: str) -> tuple[str, AgentJob] | None:
    matches: list[tuple[str, AgentJob]] = []
    for record in list_domain_records_with_ids("agent_jobs"):
        payload = record["payload"]
        if payload.get("workspaceId") != workspace_id or payload.get("id") != job_id:
            continue
        try:
            matches.append((record["id"], AgentJob.model_validate(payload)))
        except ValueError:
            return None
    return matches[0] if len(matches) == 1 else None


def get_job(job_id: str, workspace_id: str) -> AgentJob | None:
    record = _job_record(workspace_id, job_id)
    return record[1] if record else None


def cancel_job(job_id: str, workspace_id: str) -> AgentJob | None:
    record = _job_record(workspace_id, job_id)
    if record is None:
        return None
    record_id, job = record
    if job.status in ("succeeded", "blocked", "failed"):
        return job
    updated = job.model_copy(update={"status": "cancelled", "updatedAt": _now(), "finishedAt": _now()})
    save_record("agent_jobs", record_id, updated.model_dump())
    return updated


def retry_job(job_id: str, workspace_id: str) -> AgentJob | None:
    record = _job_record(workspace_id, job_id)
    if record is None:
        return None
    record_id, job = record
    if job.status != "failed":
        return job
    updated = job.model_copy(
        update={
            "status": "queued",
            "error": None,
            "runId": None,
            "traceId": None,
            "updatedAt": _now(),
            "startedAt": None,
            "finishedAt": None,
        }
    )
    save_record("agent_jobs", record_id, updated.model_dump())
    return updated


def process_next_job(workspace_id: str) -> AgentJobProcessResponse | None:
    queued = [job for job in list_jobs(workspace_id, 100) if job.status == "queued"]
    queued.sort(key=lambda item: item.createdAt)
    if not queued:
        return None
    return process_job(queued[0].id, workspace_id)


def process_job(job_id: str, workspace_id: str) -> AgentJobProcessResponse | None:
    record = _job_record(workspace_id, job_id)
    if record is None:
        return None
    _, initial_job = record
    with identity_execution_guard(workspace_id, {initial_job.request.agentId}):
        record = _job_record(workspace_id, job_id)
        if record is None:
            return None
        record_id, job = record
        if job.status != "queued":
            return AgentJobProcessResponse(job=job)

        identity = _job_identity(workspace_id, job.request.agentId)
        if identity is None or not _identity_allows_execution(identity, job) or not _consume_job_lease(identity, job, record_id):
            finished = _now()
            blocked = job.model_copy(
                update={
                    "status": "blocked",
                    "error": "Agent authority is unavailable for execution",
                    "updatedAt": finished,
                    "finishedAt": finished,
                }
            )
            claimed = compare_and_set_record_status(
                "agent_jobs",
                record_id,
                "queued",
                "blocked",
                blocked.model_dump(exclude={"status"}),
                workspace_id=workspace_id,
            )
            current = AgentJob.model_validate(claimed) if claimed else get_job(job_id, workspace_id)
            return AgentJobProcessResponse(job=current or blocked)

        started = _now()
        running_payload = compare_and_set_record_status(
            "agent_jobs",
            record_id,
            "queued",
            "running",
            {
                "attempts": job.attempts + 1,
                "updatedAt": started,
                "startedAt": started,
                "finishedAt": None,
            },
            workspace_id=workspace_id,
        )
        if running_payload is None:
            current = get_job(job_id, workspace_id)
            return AgentJobProcessResponse(job=current) if current else None
        running = AgentJob.model_validate(running_payload)

    # Never hold the lifecycle boundary while calling an external provider. A
    # kill switch can cancel the running claim immediately; completion CAS then
    # prevents stale provider output from resurrecting the job.
    try:
        run, trace = run_agent(running.request)
        run_payload = {**run.model_dump(), "workspaceId": workspace_id}
        trace_payload = {**trace.model_dump(), "workspaceId": workspace_id}
        save_record("agent_runs", _record_id(workspace_id, run.id), run_payload)
        save_record("traces", _record_id(workspace_id, trace.id), trace_payload)
        finished = _now()
        status = "blocked" if run.decision == "block" else "succeeded"
        completed_payload = compare_and_set_record_status(
            "agent_jobs",
            record_id,
            "running",
            status,
            {
                "runId": run.id,
                "traceId": trace.id,
                "updatedAt": finished,
                "finishedAt": finished,
                "error": None,
            },
            workspace_id=workspace_id,
        )
        current = AgentJob.model_validate(completed_payload) if completed_payload else get_job(job_id, workspace_id)
        return AgentJobProcessResponse(job=current or running, run=run, trace=trace)
    except Exception as exc:  # noqa: BLE001 - worker records operational failure as job state.
        finished = _now()
        failed_status = "queued" if running.attempts < running.maxAttempts else "failed"
        failed_payload = compare_and_set_record_status(
            "agent_jobs",
            record_id,
            "running",
            failed_status,
            {
                "error": str(exc),
                "updatedAt": finished,
                "finishedAt": finished if failed_status == "failed" else None,
            },
            workspace_id=workspace_id,
        )
        current = AgentJob.model_validate(failed_payload) if failed_payload else get_job(job_id, workspace_id)
        return AgentJobProcessResponse(job=current or running)


def _job_identity(workspace_id: str, agent_id: str) -> dict[str, Any] | None:
    matches = []
    for record in list_domain_records_with_ids("agent_identities"):
        payload = record["payload"]
        if payload.get("workspaceId") != workspace_id:
            continue
        if agent_id in {payload.get("id"), payload.get("agentId")}:
            matches.append(payload)
    return matches[0] if len(matches) == 1 else None


def _identity_allows_execution(identity: dict[str, Any], job: AgentJob) -> bool:
    if identity.get("status") in {"disabled", "revoked"}:
        return False
    if "agent:run" not in identity.get("permissions", []):
        return False
    if identity.get("environment") not in {"all", job.request.environment}:
        return False
    if job.request.environment == "prod" and identity.get("productionAccessStatus") != "approved":
        return False
    return True


def _consume_job_lease(identity: dict[str, Any], job: AgentJob, job_record_id: str) -> bool:
    request = job.request
    if not request.authorizationLeaseId or not request.authorizationContextHash:
        return False
    if request.providerMode == "auto" or not request.provider or not request.model:
        return False
    if request.provider not in identity.get("providerAccess", []):
        return False
    if (request.provider == "local") != (request.providerMode == "local"):
        return False
    leases = [
        record
        for record in list_domain_records_with_ids("agent_authorization_leases")
        if record["payload"].get("workspaceId") == job.workspaceId
        and record["payload"].get("id") == request.authorizationLeaseId
    ]
    if len(leases) != 1:
        return False
    lease_record = leases[0]
    lease = lease_record["payload"]
    input_hash = request.input if request.input.startswith("sha256:") else f"sha256:{sha256(request.input.encode('utf-8')).hexdigest()}"
    expected = {
        "action": "agent_run",
        "toolCategory": "agent_runtime",
        "operation": "execute",
        "contextHash": request.authorizationContextHash,
        "contentHash": input_hash,
        "provider": request.provider,
        "model": request.model,
        "environment": request.environment,
        "risk": "high",
    }
    aliases = {identity.get("id"), identity.get("agentId"), request.agentId}
    if lease.get("identityId") not in aliases or any(lease.get(key) != value for key, value in expected.items()):
        return False
    if lease.get("status") != "active":
        return False
    try:
        if datetime.fromisoformat(str(lease["expiresAt"])) <= datetime.now():
            compare_and_set_record_status(
                "agent_authorization_leases",
                lease_record["id"],
                "active",
                "expired",
                {"expiredAt": _now()},
                workspace_id=job.workspaceId,
            )
            return False
    except (KeyError, ValueError):
        return False
    consumed = compare_and_set_record_status(
        "agent_authorization_leases",
        lease_record["id"],
        "active",
        "consumed",
        {"consumedAt": _now(), "jobRecordIdHash": f"sha256:{sha256(job_record_id.encode('utf-8')).hexdigest()}"},
        workspace_id=job.workspaceId,
    )
    return consumed is not None


def queue_summary(workspace_id: str) -> dict[str, Any]:
    jobs = list_jobs(workspace_id, 500)
    return {
        "total": len(jobs),
        "queued": sum(job.status == "queued" for job in jobs),
        "running": sum(job.status == "running" for job in jobs),
        "succeeded": sum(job.status == "succeeded" for job in jobs),
        "blocked": sum(job.status == "blocked" for job in jobs),
        "failed": sum(job.status == "failed" for job in jobs),
        "cancelled": sum(job.status == "cancelled" for job in jobs),
    }


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _stable_id(value: str) -> str:
    return sha1(value.encode("utf-8")).hexdigest()


def _record_id(workspace_id: str, record_id: str) -> str:
    return f"{workspace_id}:{record_id}"
