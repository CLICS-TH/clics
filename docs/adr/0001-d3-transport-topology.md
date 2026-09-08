# ADR 0001 — Build no more D3 transport until a GDCC VM exists

- **Status:** Accepted, 2026-09-08. Revisit when the VM is provisioned or refused.
- **Scope:** how the CLICS backend reaches an on-premise RIMPL under decision **D3**.
- **Supersedes nothing.** **D7** (accept the Railway→on-prem raw-PII hop over Tailscale) still
  stands; this record is about *transport*, not about where PII is processed.

## Why this exists

Two different network topologies have now been designed for the same hop, and a third session would
have designed a fourth. Each design is a week of work that only pays off in one of the futures.
This record exists so the next session builds nothing until the future is known.

## Context

`rimplEvaluate(...)` carries the raw transcript and `patient_ref` from the backend to RIMPL, which
is what strips them. Today that hop is Railway-private (`rimpl.railway.internal:3003`). Under D3
RIMPL moves on-premise and the hop crosses a network we do not own, which is what D7 accepted.

**Topology A — Railway backend + userspace Tailscale.** Built on `codex/d3-cutover-bridge` (PR #90):
`backend/Dockerfile.tailnet`, an entrypoint, a scoped `RIMPL_HTTP_PROXY` dispatcher on six RIMPL
calls, and an `undici` dependency. It exists in this shape for exactly one reason: a Railway
container has no TUN device, so the Tailscale client must run in userspace and be reached through an
HTTP proxy rather than through kernel routes (`backend/docker-entrypoint.sh`).

**Topology B — a GDCC VM.** Proposed by Aj. Chanvit on 2026-09-07: run CLICS on a project-controlled
VM inside GDCC, expose it publicly behind nginx, and reach the tailnet from there. A VM has a TUN
device and a static IP, so Topology A's entire mechanism becomes unnecessary — and a static IP is
allowlistable, which a Railway container's rotating egress IP never was.

Topology B is also the one CREC082 §10.1 describes (run in an environment the project controls).

## Decision

**Neither. Build no further transport for either topology until the VM is provisioned or refused.**

Concretely:

- PR #90 stays **open and unmerged**. Its builder switch has been disarmed
  (`backend/Dockerfile` → `backend/Dockerfile.tailnet`, so Railway's auto-detection no longer fires;
  see that PR). Its doc corrections were split to #95 and can land on their own.
- Nothing is deleted. If GDCC is refused, Topology A is still there and still correct.
- No nginx config, no VM provisioning scripts, no DNS, no certificate work until the VM exists.

## Why not just choose GDCC now

Because three load-bearing facts about the VM are **unverified**, and each one can invalidate the
design. They were asked on 2026-09-07 and are unanswered:

1. Does the VM get a public IP with 443 open? (Without it, physicians cannot reach the portal.)
2. May a Tailscale client be installed? (Outbound only — but a hardened government image may forbid it.)
3. Who administers the box? (Determines who can change a firewall rule later.)

Committing to a topology whose prerequisites are unconfirmed is how Topology A was built twice.

## Consequences

- If the VM arrives and answers 1–3 favourably, Topology A's userspace-Tailscale mechanism is dead
  weight: the entrypoint, `RIMPL_HTTP_PROXY`, the ProxyAgent dispatcher and the `undici` dependency
  all exist only to work around a missing TUN device. Close #90 rather than merge it, and keep the
  runbook's *access, authentication and rollback* gates, which apply to either topology.
- If backend and RIMPL end up on the **same** GDCC VM, the hop collapses to loopback and the D7
  concession may no longer be needed. That is a re-derivation to do at the time, **not** a
  conclusion of this ADR — it depends on where each component actually lands.
- **Moving the application to GDCC does not put the data in Thailand.** Supabase is in Tokyo. The
  risk register already records that claiming otherwise in a CREC document would be false
  (`docs/LOCAL-MODEL-ROADMAP.md`, risk table). A database migration is a separate decision that has
  not been taken.
- Nothing here blocks G0.5, which is the programme's actual go/no-go and needs no box at all.

## What would change this decision

| Trigger | Then |
|---|---|
| VM provisioned, answers to 1–3 favourable | Adopt Topology B. Close #90. Write ADR 0002 with the as-built network. |
| VM provisioned but Tailscale forbidden | Re-open the question — neither topology is ready; the box is reached some third way or not at all. |
| GDCC refused or stalls past the point of use | Revive Topology A: merge #90, set `RAILWAY_DOCKERFILE_PATH`, follow the D3 runbook. |
| D3 dropped entirely | Close #90. `evaluate` stays on `claude-sonnet-4-6` regardless — D18's verdict is `insufficient`, so D3 only ever bought chat/criteria/discuss cost. |
