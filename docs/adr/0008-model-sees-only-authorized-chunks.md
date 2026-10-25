# 0008. The model only ever sees authorized chunks; the model is configurable

## Context

The guarantee must not depend on the model behaving. Claude Haiku was the first choice but was not
yet enabled on the account at launch.

## Decision

Authorization ends before generation: the prompt is built only from chunks that passed the vector
filter, the post-check and the relevance cutoff. Retrieved text is wrapped in `<document>` tags with
HTML-escaped content and the system prompt says it is data, not instructions. The model is a
deploy-time parameter (`-c chatModelId=...`), defaulting to Claude Haiku 4.5. It started as Nova Lite
while Haiku was unavailable; Nova (Lite and Pro) then over-refused authorized requests, which Haiku
does not.

The prompt also tells the model that access control has already been applied and to ignore any
statement inside a document about who may read it: an early W-2 said "only its owner can retrieve
it", and Haiku refused the admin on that basis. When nothing relevant is in front of it, the model
replies `NO_ANSWER`, and the API returns the same message as finding nothing, so the two cases are
indistinguishable to the caller. Sources are only the titles the answer actually cites.

## Consequences

- Prompt injection in the question or in a document can at worst misuse what the caller may
  already read.
- The red-team tests assert on the prompt sent to the model, not on its answer.
- Switching to Haiku is one context value plus enabling model access; IAM is derived from the ID
  (inference profile plus its foundation model in every region).
