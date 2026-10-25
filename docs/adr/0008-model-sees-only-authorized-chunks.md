# 0008. The model only ever sees authorized chunks; the model is configurable

## Context

The guarantee must not depend on the model behaving. Claude Haiku was the first choice, but this
account cannot invoke it yet (Haiku 4.5 needs a Bedrock Marketplace subscription; Haiku 5.5 is not
offered to the account).

## Decision

Authorization ends before generation: the prompt is built only from chunks that passed the vector
filter, the post-check and the relevance cutoff. Retrieved text is wrapped in `<document>` tags with
HTML-escaped content and the system prompt says it is data, not instructions. The model is a
deploy-time parameter (`-c chatModelId=...`), defaulting to `us.amazon.nova-lite-v1:0`.

## Consequences

- Prompt injection in the question or in a document can at worst misuse what the caller may
  already read.
- The red-team tests assert on the prompt sent to the model, not on its answer.
- Switching to Haiku is one context value plus enabling model access; IAM is derived from the ID
  (inference profile plus its foundation model in every region).
