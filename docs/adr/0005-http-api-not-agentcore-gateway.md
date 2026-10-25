# 0005. A plain HTTP API, not the AgentCore Gateway

## Context

Sentinel ships an AgentCore Gateway adapter. This demo's client is a web page, not an MCP agent.

## Decision

API Gateway HTTP API with a Cognito JWT authorizer in front of two Lambda functions (chat, and
everything else). The handlers call sentinel-engine directly and re-verify the token with the
engine's `TokenVerifier`.

## Consequences

- Cheaper and simpler: no gateway, interceptors or principal envelope.
- The chat handler runs `secure_search`'s steps explicitly (`resolve_scope`, search,
  `authorize_chunks`) so the page can show what each layer did. Same engine functions, same order.
- The AgentCore path stays demonstrated in the Sentinel repo itself.
