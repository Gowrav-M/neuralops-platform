from __future__ import annotations

from typing import Any


POLICIES: list[dict[str, Any]] = [
    {"id": "pol_01", "name": "Jailbreak Injection Shield", "mode": "block", "enabled": True, "matches": 0, "severity": "Critical"},
    {"id": "pol_02", "name": "Credential Exfiltration Guard", "mode": "block", "enabled": True, "matches": 0, "severity": "Critical"},
    {"id": "pol_03", "name": "External Tool Approval", "mode": "review", "enabled": True, "matches": 0, "severity": "Major"},
]

SETTINGS: dict[str, Any] = {
    "retentionDays": 30,
    "apiKeys": [],
    "webhooks": [],
    "teamMembers": [],
    "ssoStatus": "Not configured",
    "billingPlan": "Local workspace",
    "nextInvoice": None,
}
