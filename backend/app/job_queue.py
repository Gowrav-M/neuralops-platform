from __future__ import annotations

from datetime import datetime, timezone
from hashlib import sha1
from typing import Any

from .agent_runtime import run_agent
from .database import get_record, list_records, save_record
from .schemas import AgentJob, AgentJobProcessResponse, AgentJobSubmitRequest


def submit_job(request: AgentJobSubmitRequest) -> AgentJob:
    now = _now()
    job = AgentJob(
        id=f"job_{_stable_id(request.agentId + request.input + now)[:12]}",
        status="queued",
        request=request,
        attempts=0,
        maxAttempts=request.maxAttempts,
        createdAt=now,
        updatedAt=now,
    )
    save_record("agent_jobs", job.id, job.model_dump())
    return job


def list_jobs(limit: int = 25) -> list[AgentJob]:
    jobs = [AgentJob.model_validate(item) for item in list_records("agent_jobs")]
    jobs.sort(key=lambda item: item.createdAt, reverse=True)
    return jobs[:limit]


def get_job(job_id: str) -> AgentJob | None:
    payload = get_record("agent_jobs", job_id)
    return AgentJob.model_validate(payload) if payload else None


def cancel_job(job_id: str) -> AgentJob | None:
    job = get_job(job_id)
    if job is None:
        return None
    if job.status in ("succeeded", "blocked", "failed"):
        return job
    updated = job.model_copy(update={"status": "cancelled", "updatedAt": _now(), "finishedAt": _now()})
    save_record("agent_jobs", updated.id, updated.model_dump())
    return updated


def retry_job(job_id: str) -> AgentJob | None:
    job = get_job(job_id)
    if job is None:
        return None
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
    save_record("agent_jobs", updated.id, updated.model_dump())
    return updated


def process_next_job() -> AgentJobProcessResponse | None:
    queued = [job for job in list_jobs(100) if job.status == "queued"]
    queued.sort(key=lambda item: item.createdAt)
    if not queued:
        return None
    return process_job(queued[0].id)


def process_job(job_id: str) -> AgentJobProcessResponse | None:
    job = get_job(job_id)
    if job is None:
        return None
    if job.status not in ("queued", "failed"):
        return AgentJobProcessResponse(job=job)

    started = _now()
    running = job.model_copy(update={"status": "running", "attempts": job.attempts + 1, "updatedAt": started, "startedAt": started})
    save_record("agent_jobs", running.id, running.model_dump())

    try:
        run, trace = run_agent(running.request)
        save_record("agent_runs", run.id, run.model_dump())
        save_record("traces", trace.id, trace.model_dump())
        finished = _now()
        status = "blocked" if run.decision == "block" else "succeeded"
        completed = running.model_copy(
            update={
                "status": status,
                "runId": run.id,
                "traceId": trace.id,
                "updatedAt": finished,
                "finishedAt": finished,
                "error": None,
            }
        )
        save_record("agent_jobs", completed.id, completed.model_dump())
        return AgentJobProcessResponse(job=completed, run=run, trace=trace)
    except Exception as exc:  # noqa: BLE001 - worker records operational failure as job state.
        finished = _now()
        failed_status = "queued" if running.attempts < running.maxAttempts else "failed"
        failed = running.model_copy(update={"status": failed_status, "error": str(exc), "updatedAt": finished, "finishedAt": finished if failed_status == "failed" else None})
        save_record("agent_jobs", failed.id, failed.model_dump())
        return AgentJobProcessResponse(job=failed)


def queue_summary() -> dict[str, Any]:
    jobs = list_jobs(500)
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
