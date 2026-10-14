RFC-0017: Replace point-to-point webhooks with an internal event bus

Author: Ines Kowalczyk
Status: Proposed
Discussion: #arch-rfcs, until 28 Oct

Background
---------
Corvid Robotics' fleet service currently calls six other services directly whenever a robot changes state. Every new consumer means a code change in fleet, and when one consumer is slow the whole chain backs up.

Proposal
--------
Introduce a managed event bus. Fleet publishes `robot.state_changed` once; consumers subscribe on their own.

  * Events are versioned JSON with a schema registry
  * At-least-once delivery; consumers must be idempotent
  * Retention 7 days so a consumer can replay after an outage

Alternatives considered
-----------------------
Keep webhooks but add a queue per consumer (more moving parts, same coupling). Use the database as a queue (we tried this in 2024; it hurt).

Rollout
-------
Phase 1: dual-write for telemetry and billing consumers. Phase 2: migrate the rest. Phase 3: delete the old webhook code.

Unresolved
----------
Who owns the schema registry? How do we handle ordering for a single robot?
