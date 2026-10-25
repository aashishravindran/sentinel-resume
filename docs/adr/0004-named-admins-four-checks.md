# 0004. Admins are named in the repo, and every admin call passes four checks

## Context

The admin page approves access to sensitive documents. The site has open sign-up, so the boundary
between "anyone" and "admin" is the most important one in the system. A single control (only a
Cognito group, say) fails to one console click.

## Decision

`infra/admins.json` lists admin emails and is the only way to become one. `scripts/sync_admins.py`
(run with AWS credentials) reconciles it: Cognito `admin` group, `sentinel_admin` plus all `doc_*`
tags, and the allowlist SSM parameter. Each `/api/admin/*` call requires all of:

1. `cognito:groups` contains `admin` in the verified access token
2. `sub` is in the SSM allowlist, read on every call
3. `engine.is_admin` (the `sentinel_admin` tag, via the engine's `TagAdminPolicy`)
4. a TOTP authenticator is enabled on the Cognito user (`AdminGetUser`)

Any failure returns 403 and writes an `admin_denied` audit entry naming the failed check.

## Consequences

- No API route, request or sign-up path can grant admin; `sentinel_admin` is reserved by the engine
  and cannot be requested or stamped on a document.
- A console edit to the group, a stray tag, or a stolen password alone does not make an admin.
- The allowlist is in SSM, not a Lambda environment variable, so adding or removing an admin needs
  no redeploy and a CDK redeploy never resets it (CDK does not own the parameter).
- Each admin call costs an extra SSM read and Cognito call. Acceptable at admin volumes.
