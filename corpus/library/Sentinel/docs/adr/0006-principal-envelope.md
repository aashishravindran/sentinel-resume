# 0006. A signed principal envelope for the Lambda target

## Context

AgentCore invokes a Lambda target with the tool arguments only: no headers, no token. The
target still needs to know who is calling, and the model must not be able to tell it.

## Decision

The REQUEST interceptor, having verified the JWT, adds `_sentinel_principal` to the
arguments: an HMAC-SHA256 over the user ID, a digest of the exact arguments, and a 60-second
expiry. The key lives in Secrets Manager and is readable only by Sentinel's functions. The
target opens the envelope and denies anything missing, forged, expired or issued for
different arguments. The RESPONSE interceptor removes the field from `tools/list`.

## Consequences

- Direct invocation of the target, or replaying an envelope for another query, is denied.
- Any argument the model sends under that name is overwritten by the interceptor.
- Managed KB targets do not need an envelope; the interceptor writes their filter directly.
