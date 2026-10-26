# 0003. Filter on access tags stamped at ingest, not on document IDs

## Context

Two ways to push authorization into retrieval:

1. Resolve the list of documents the user may read, and filter by document ID.
2. Stamp each document with access tags (groups) at ingest, resolve the user's tags, and
   filter by tag.

## Decision

Tags. The identity store answers "which tags may this user read?" (SpiceDB resolves that
through relationships, such as team membership). The filter stays proportional to the user's
groups, not to the size of the corpus.

Ingest is the only writer of tags. `stamp_metadata` writes `tag_<name>: true` and
`access_tags` after the caller's metadata and rejects reserved keys, so a document cannot
overwrite its own access stamp.

## Consequences

- Filters stay small and stable however many documents a user can read.
- Changing a document's audience means re-ingesting it; changing a user's audience is
  instant.
- Recall stays at 1.00 where post-filtering degrades to roughly 1/N (see `docs/benchmarks.md`).
