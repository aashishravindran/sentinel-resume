# 0003. Grants expire by being ignored, not by being deleted

## Context

Approvals are time-boxed. Something has to remove access when the time is up, and that must never
fail open (Sentinel ADR 0002).

## Decision

A grant is a top-level number attribute on the user's identity item, holding its expiry:

    {"user_id": "<sub>", "tags": {"public"}, "grant_doc_offer_letter": 1767225600}

`ExpiringDdbIdentity.get_tags` returns base tags plus grants whose expiry is in the future, read
with a strongly consistent `GetItem` on every call. Approve is one `SET`; revoke is one `REMOVE`.

## Consequences

- Expiry is exact and needs no sweeper, TTL job or schedule that could lag or fail.
- Revocation applies on the user's next question; nothing is cached.
- Expired attributes linger on the item. Harmless (they are ignored), and a later approval
  overwrites them.
- Top-level attributes rather than a `grants` map, because DynamoDB cannot `SET grants.x` when the
  map does not exist yet, and a two-step write would not be atomic.
