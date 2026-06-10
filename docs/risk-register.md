# Risk Register And Exceptions

The Risk Register stores time-boxed approvals for accepted AI risk. It is for cases where a team knowingly ships or operates with an unresolved release, SLO, gateway, estate, detection, incident, or policy concern.

## Why It Exists

Enterprise teams sometimes accept risk, but accepted risk must not disappear. NeuralOps records:

- what risk was accepted
- who owns it
- who approved it
- why it was accepted
- which compensating controls are required
- when the exception expires
- whether it was revoked or expired

## API

```http
GET /api/risk-exceptions
POST /api/risk-exceptions
PATCH /api/risk-exceptions/{exception_id}
POST /api/risk-exceptions/{exception_id}/revoke
```

Write actions require `policy:write` permission and create audit events.

## Action Center Integration

Active critical exceptions and soon-expiring exceptions appear in Action Center. This keeps accepted risk visible until it is revoked or naturally expires.

## Operating Rule

An exception is not a fix. It is a temporary record that allows a team to proceed only while compensating controls are active and an owner remains accountable.
