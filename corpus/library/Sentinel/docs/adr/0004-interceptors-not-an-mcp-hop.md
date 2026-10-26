# 0004. Gateway mode runs the engine inside the interceptors

## Context

AgentCore Gateway could reach Sentinel two ways: register the Sentinel MCP server as a
gateway target (one more network hop, and the gateway's caller identity would have to be
forwarded into it), or run Sentinel's decision logic in the gateway's own interceptors.

## Decision

The REQUEST and RESPONSE interceptor Lambdas import `sentinel-engine` and call the identity
store directly. Sentinel is the policy decision point; the gateway is the enforcement point.

- **REQUEST:** verify the JWT, resolve scope, rebuild the tool arguments (Managed KB filter
  written, never merged), and deny anything else.
- **RESPONSE:** strip control arguments from `tools/list`, re-verify, re-resolve scope and
  drop any chunk outside it.

The MCP server remains the default deployment; Gateway mode is a second adapter over the same
engine.

## Consequences

- One request hop fewer than an MCP-server target, with identical decisions (conformance suite).
- A gateway allows one interceptor of each kind, Lambda only. Sentinel occupies both.
- Interceptors are buffered. `AgenticRetrieveStream` streams and synthesizes answers
  server-side, so a response check cannot un-leak prose. It is denied until pre-filtering can
  be guaranteed for it.
