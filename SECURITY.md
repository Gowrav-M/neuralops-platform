# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through [GitHub Security Advisories](https://github.com/Gowrav-M/neuralops-platform/security/advisories/new).

Include a clear description, affected revision or component, reproduction steps or proof of concept, impact assessment, and any suggested mitigation. Do not include secrets, production credentials, or personal data.

**Do not disclose the vulnerability publicly** in issues, discussions, pull requests, social media, or elsewhere before we have coordinated a fix and disclosure timeline. Public reports may be closed without technical discussion to protect users.

We will acknowledge reports, assess impact, coordinate remediation where practical, and agree on disclosure timing with the reporter. No response-time, bounty, or support-level commitment is implied.

## Scope

The repository's API, authorization and lease lifecycle, identity/credential handling, persistence boundaries, CI actions, and deployment configuration are in scope. Security reports about third-party providers should also be reported to the relevant provider.

For immediate operational containment of a deployed NeuralOps instance, use the identity revoke or kill-switch API path in your authenticated environment, rotate exposed credentials, and preserve relevant audit evidence.
