# 0005. One server; admin tools gated by role

## Context

v1's ingest tools let the model choose `access_tags` (mislabeling or poisoning content) and
read any `pdf_path` the server could reach. `list_user_relationships` let anyone enumerate
anyone's permissions, and `check_config` exposed runtime settings.

A separate admin server would hide these tools from the model entirely. Role gating keeps one
deployable, and with identity bound to the transport (0001) the gate is enforced in code.

## Decision

One server. `ingest_document`, `ingest_pdf`, `check_config` and `list_user_relationships`
require an admin:

- SpiceDB: `administer` on `platform:sentinel` (`CheckPermission`)
- Other identity stores: the reserved `sentinel_admin` tag, which can never be stamped on a
  document and is stripped from retrieval scope

`pdf_path` must resolve inside `SENTINEL_INGEST_DIR`, so absolute paths, `..` and escaping
symlinks are rejected. Without that variable, file paths are disabled. Inline PDFs are capped
at 1 MB.

## Consequences

Non-admins can still see the admin tools in `tools/list`; calling them denies. Read-only
`what_can_i_access` explains a caller's own scope. Tests: `tests/redteam/test_ingest_lockdown.py`.
