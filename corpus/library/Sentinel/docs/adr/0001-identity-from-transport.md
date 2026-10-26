# 0001. Identity comes from the transport, never from tool arguments

## Context

v1 exposed `secure_search(query, user_id)`. The engine enforced permissions correctly, but
for whichever `user_id` the model passed. An agent could call `user_id="ceo"`, through a
prompt injection or by plain mistake, and Sentinel would enforce the CEO's access.

The README's own sequence diagram (`AI->>S: secure_search(query, user_id)`) documented the
assumption.

## Decision

The caller is resolved from the connection on every call. No tool accepts a user ID.

| Transport | Identity |
|---|---|
| MCP over stdio | The user who launched the server (`SENTINEL_STDIO_USER`). The server refuses to start without it. |
| MCP over HTTP | The `sub` claim of a bearer JWT from the configured OIDC issuer. The server refuses to start without OIDC settings. |
| AgentCore Gateway | The `sub` claim of the JWT the gateway's authorizer accepted, re-verified by the interceptors. |

The user is always `sub`. `client_id` and `azp` name the calling application, not the user.
FastMCP's `AccessToken.client_id` falls back to `sub`, so Sentinel reads `claims["sub"]` directly.

All adapters run the same post-signature checks (`principal_from_claims`): expiry, `nbf`,
allowed clients, and a subject format that rejects `*` (a SpiceDB wildcard) and emails.

## Consequences

- Spoofing through arguments is impossible by construction. FastMCP rejects unknown
  arguments, and the Gateway request interceptor rebuilds arguments from scratch.
- Token claims are a snapshot, but permissions are not cached. Scope is resolved live on every
  call, so revocation takes effect on the next request.
- The calling application must forward the *user's* token end to end. If an agent runtime
  calls with its own machine credential, the token names the agent, not the user (the
  confused-deputy problem).
- Tests: `tests/redteam/test_user_id_spoofing.py`, `tests/redteam/test_token_matrix.py`.
