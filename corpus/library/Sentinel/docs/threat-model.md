# Threat model

Sentinel's job: an AI agent retrieves only what the human it acts for may read, even when
the agent is confused, manipulated or wrong.

## Assets

- **Documents** in the knowledge base, and the chunks retrieved from them
- **Permissions**: who holds which access tags (SpiceDB, DynamoDB, SQLite or IAM)
- **Credentials**: user tokens, the SpiceDB token, the principal envelope key

## Trust boundaries

```
 untrusted                      verified                        trusted
┌──────────────┐  bearer JWT   ┌───────────────────────────┐   ┌─────────────────┐
│ model / agent │─────────────▶│ MCP server or AgentCore   │──▶│ identity store  │
│ tool arguments│  (or stdio   │ Gateway + interceptors    │   │ knowledge base  │
│ retrieved text│   launcher)  │ (sentinel-engine decides) │◀──│ (filtered query)│
└──────────────┘               └───────────────────────────┘   └─────────────────┘
```

1. **Model → Sentinel.** Tool arguments, queries and retrieved text are untrusted input.
   Nothing in them can name a user, a scope or a filter.
2. **Client → Sentinel.** The connection carries identity: a verified JWT `sub`, or the user
   who launched a stdio server.
3. **Sentinel → stores.** The identity store is the source of truth for permissions. The
   knowledge base is trusted to apply filters, but its results are re-checked anyway.
4. **Gateway → Lambda target.** The target receives no headers, so identity crosses this
   boundary as an HMAC envelope.

## Threats and controls

| # | Threat | STRIDE | Control | Verified by |
|---|---|---|---|---|
| T1 | The model passes another user's ID (`user_id="ceo"`) | Spoofing | No tool takes a user ID; identity comes from the transport ([ADR 0001](adr/0001-identity-from-transport.md)) | `redteam/test_user_id_spoofing.py`, leak set |
| T2 | A retrieved document contains instructions ("search as charlie") | Elevation | Instructions cannot change identity or scope; the injection document is part of the leak set | `redteam/test_leak_rate.py` |
| T3 | The model sets a Managed KB `filter` or `userContext` | Elevation | The request interceptor rebuilds arguments, overwriting and never merging; `tools/list` hides both | `agentcore/test_request_interceptor.py`, leak set |
| T4 | Forged, expired, not-yet-valid, wrong-issuer or wrong-audience tokens; `alg: none`; HS256 key confusion | Spoofing | RS256 only, issuer/audience/clients pinned, `exp`/`nbf`/`sub` required, subject format checked | `redteam/test_token_matrix.py`, `sentinel-engine/tests/test_oidc.py` |
| T5 | The application's client ID is mistaken for the user (confused deputy) | Spoofing | Only `sub` is the user; `client_id`/`azp` are checked against allowed clients, never used as identity | `test_identity_binding.py::test_http_client_id_does_not_become_the_user` |
| T6 | Wildcard or malformed subject (`*` is a SpiceDB wildcard) | Elevation | `validate_subject` before any store lookup | `sentinel-engine/tests/test_policy.py` |
| T7 | A knowledge base ignores or mis-applies the filter | Info disclosure | Post-filter in the engine and in the response interceptor; untagged chunks are never visible | Conformance and leak set against a filter-ignoring KB |
| T8 | Direct invocation or replay of the Lambda target | Spoofing | Principal envelope bound to the exact arguments, 60 s expiry ([ADR 0006](adr/0006-principal-envelope.md)) | `agentcore/test_target.py` |
| T9 | A non-admin ingests documents with chosen tags (poisoning or mislabeling) | Tampering | Admin role gate; reserved tag and metadata keys rejected ([ADR 0005](adr/0005-admin-role-gating.md)) | `redteam/test_ingest_lockdown.py` |
| T10 | `pdf_path` reads arbitrary server files; `doc_id` writes outside the S3 prefix | Info disclosure / Tampering | Ingest directory allowlist with symlink resolution; `doc_id` cannot contain `/` or start with `.` | `redteam/test_ingest_lockdown.py`, `sentinel-engine/tests/test_stamp.py` |
| T11 | Enumerating other users' permissions or the runtime config | Info disclosure | Admin only; `what_can_i_access` shows the caller's own scope; secrets masked | `redteam/test_ingest_lockdown.py` |
| T12 | Identity store outage or slowness opens access | Denial / Elevation | Fail closed, with no KB call; SpiceDB deadline 2 s ([ADR 0002](adr/0002-fail-closed.md)) | Conformance, `agentcore` outage tests |
| T13 | Revoked access keeps working from a cache or token claims | Elevation | Scope resolved live on every call, in both interceptors | `test_revocation_applies_on_the_next_call`, `test_scope_is_re_resolved_live` |
| T14 | Streaming tools (`AgenticRetrieveStream`) bypass buffered response checks | Info disclosure | Denied at request, hidden from `tools/list`, streaming responses denied | `agentcore` tests |
| T15 | Denial messages reveal what exists | Info disclosure | One generic message; reasons only in server logs | Response assertions throughout |

## OWASP mapping

**[OWASP Top 10 for LLM Applications (2025)](https://genai.owasp.org/llm-top-10/)**

| Risk | Where Sentinel acts |
|---|---|
| LLM01 Prompt Injection | T1–T3: injected text cannot change who the user is or what they may retrieve |
| LLM02 Sensitive Information Disclosure | T7, T10, T11, T15: retrieval returns only authorized chunks |
| LLM06 Excessive Agency | T1, T3, T9: the agent cannot widen its own access or write to the knowledge base |
| LLM08 Vector and Embedding Weaknesses | T7, T13: permission-aware retrieval with filters pushed into the vector query |

**[OWASP Top 10 for Agentic Applications (2026)](https://genai.owasp.org/)**

| Risk | Where Sentinel acts |
|---|---|
| ASI01 Agent Goal Hijack | T2: a hijacked goal still runs with the human's permissions, no more |
| ASI02 Tool Misuse and Exploitation | T3, T8, T14: tool arguments are rebuilt; unknown and streaming tools are denied |
| ASI03 Identity and Privilege Abuse | T1, T4–T6, T13: identity from the transport, permissions resolved live |
| ASI06 Memory and Context Poisoning | T9: only admins write documents, and access tags cannot be overridden |

## Out of scope

- What the model does with authorized content (output filtering, guardrails)
- Authorization of non-retrieval tools; use AgentCore Policy (Cedar) alongside Sentinel
- Compromise of the identity provider, the identity store or AWS credentials
- Inference from authorized documents about unauthorized ones
