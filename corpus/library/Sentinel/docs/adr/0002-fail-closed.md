# 0002. Every failure denies

## Decision

Sentinel answers "no" whenever it cannot prove "yes":

- an empty scope, before any knowledge base call
- an identity store error or timeout (SpiceDB calls carry a 2 s deadline)
- a missing, expired, not-yet-valid or unverifiable token
- a malformed subject or tag
- an admin check that errors
- a Gateway event, tool, method or tool result that cannot be parsed and re-checked,
  including streaming responses
- a missing, forged or expired principal envelope

Denials return one generic message. Reasons go to server logs, never to the model.

## Consequences

An outage in the identity store makes retrieval unavailable rather than open. That trade-off
is intended. Tests: `tests/conformance/test_conformance.py::test_denials_never_reach_the_knowledge_base`
and the identity-outage cases in `tests/agentcore` and `sentinel-engine/tests/test_policy.py`.
