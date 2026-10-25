# 0002. Every sensitive document gets its own tag

## Context

Sentinel authorizes by tag, and a chunk is visible if it shares **any** tag with the caller's scope
(OR semantics). Recruiters must be able to get one sensitive document without getting the others.

## Decision

Public documents share the tag `public`. Each sensitive document carries exactly one tag of its own
(`doc_offer_letter`, `doc_salary_history`, `doc_references`, `doc_tax_w2_2025`) and **no** broad tag.
The catalog (`sentinel_resume/catalog.json`) maps document to tag and says whether it is requestable.

## Consequences

- Granting a document is adding one tag; nothing else opens.
- Adding a broad tag such as `public` to a sensitive document would open it to everyone. The tag
  lives in one place (the catalog) and the red-team tests would fail.
- `doc_tax_w2_2025` is `requestable: false`: the request API refuses it, so it can only ever be read
  by holders of that tag (the admin).
- The admin holds every `doc_*` tag as base tags, set by `scripts/sync_admins.py`.
