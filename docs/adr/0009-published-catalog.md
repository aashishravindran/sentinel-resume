# 0009. Requests come from a published catalog, never from search results

## Context

Sentinel's threat model (T15) says denials must not reveal what exists. Yet a recruiter has to know
what they can ask for.

## Decision

The catalog of documents (title, one-line description, requestable or not) is published on the
Request access page. Chat never says "there is a document about X you can't see": when nothing
authorized and relevant is found, it returns the engine's `NO_RELEVANT_ACCESS` message plus a
generic pointer to the Request access page.

## Consequences

- What exists is a deliberate, owner-written disclosure, not a side channel from search scores.
- The catalog is the only source of requestable tags; the request API rejects anything else.
