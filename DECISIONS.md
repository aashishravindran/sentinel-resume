# Decisions

The decisions that shape this demo, with the reasoning and the alternatives turned down. The larger
ones have an ADR in [`docs/adr/`](docs/adr/README.md). For how requests move through the system, see
[FLOW.md](FLOW.md).

## What the demo has to prove

A recruiter can sign up, chat about my resume, and **cannot** get the assistant to reveal a document
they have not been granted, however they phrase the question. Granting a document works on their
next question, and revoking or expiring a grant takes it away just as fast.

## Architecture

| Decision | Chosen | Turned down | Why |
|---|---|---|---|
| Hosting | AWS serverless: CloudFront, HTTP API, Lambda, DynamoDB, Cognito | AgentCore Gateway path; one container on Fly/Lightsail | Close to $0 idle, AWS-native identity, reuses Sentinel's DynamoDB and JWT handling ([0005](docs/adr/0005-http-api-not-agentcore-gateway.md)) |
| Vector store | S3 Vectors, queried directly | Bedrock KB on OpenSearch Serverless; Managed KB; Chroma | Metadata filter in the query, no idle cost, no ingestion jobs ([0001](docs/adr/0001-s3-vectors-knowledge-store.md)) |
| Embeddings | Titan Text Embeddings v2, 1024-d, normalized | Cohere, Nova multimodal | Cheapest on Bedrock, IAM auth, fine at this size |
| Chunking | Section-aligned, "Title > Section" prefix | Fixed-size paragraph chunks | Short sections (education) were unretrievable without their heading: 0.10 → 0.63 |
| Unanswerable questions | Model replies `NO_ANSWER`; API returns the same message as "no access" | One reply whether nothing was found or nothing relevant was found; no model-invented "policy" text |
| Sources | Only titles the answer cites in `[brackets]`, intersected with the chunks sent | A refusal no longer shows "Sources: Projects" |
| Relevance floor | 0.05 (was 0.12) | Casual phrasing scored the right document at 0.11; the model's `NO_ANSWER` now does the filtering |
| Answer model | Claude Haiku 4.5 on Bedrock, configurable | Nova Lite, Nova Pro | Nova over-refused authorized requests (an admin asking for the W-2); Haiku follows the "access already enforced" instruction ([0008](docs/adr/0008-model-sees-only-authorized-chunks.md)) |
| API shape | Same origin under `/api` via CloudFront | Separate API domain with CORS | No CORS to misconfigure; build is deployment-agnostic ([0007](docs/adr/0007-same-origin-api.md)) |
| Design library | Public READMEs, flows and ADRs of every public project, copied into `corpus/library/` by a manual sync; this repo's own read in place | Fetch from GitHub at deploy time; only the resume | Recruiters ask *why*; answers ground in the ADRs. Copies are reviewed in a PR, and deploys don't depend on GitHub ([0013](docs/adr/0013-design-library.md)) |
| Chunk titles | Project + document title on every chunk (*Sentinel ADR 0001: ...*) | The document's own heading | Two projects both have an "ADR 0001"; the project name is what separates them in the embedding |
| Answer formatting | A small Markdown subset (lists, bold, code) rendered as React elements | Plain text only | Haiku used bold anyway; rendering a safe subset reads better and can't inject HTML |
| Frontend | Vite + React + `aws-amplify/auth` (auth only) | Amplify Hosting/Gen2; hosted UI | Small bundle, custom sign-up/TOTP flow, CDK owns all infra |

## Access model

| Decision | Chosen | Why |
|---|---|---|
| Identity | Verified Cognito **access** token `sub`; body never read for identity | Sentinel ADR 0001. ID tokens are refused (`token_use` check) |
| Default scope | `public` on sign-up (PostConfirmation trigger) | Every recruiter reads the resume and projects |
| Sensitive docs | One tag per document, no broad tags | Tags are OR'd; a grant must open exactly one doc ([0002](docs/adr/0002-one-tag-per-sensitive-document.md)) |
| Grants | `grant_<tag> = expiry` on the identity item, read live | Exact expiry, no sweeper, atomic approve and revoke ([0003](docs/adr/0003-expiring-grants.md)) |
| Never-shareable docs | `requestable: false` in the catalog (the W-2) | Shows that some data is never grantable |
| What can be requested | Published catalog only | Threat model T15: no hints from search ([0009](docs/adr/0009-published-catalog.md)) |
| Admins | Named in `infra/admins.json`; four checks per call | Open sign-up makes this the critical boundary ([0004](docs/adr/0004-named-admins-four-checks.md)) |
| Admin allowlist storage | SSM parameter written by `sync_admins.py` | Read per call, no redeploy, CDK never resets it |
| Audit | DynamoDB table (90-day TTL) and CloudWatch JSON logs | Grants, denials, revokes and failed admin checks are visible on `/admin` |

## Abuse and cost

| Decision | Chosen | Why |
|---|---|---|
| Rate limits | Stage throttle, per-user DynamoDB windows, daily site breaker, sign-up cap, reserved concurrency | Each layer is cheap; together they bound cost ([0006](docs/adr/0006-layered-rate-limits.md)) |
| WAF | Not used | $5+/month idle for little gain at this scale |
| No-result questions | Never call the model | Saves cost and isn't counted against the site budget |
| Budget | AWS Budget email at 80% of $10/month | A backstop, not a control |
| Data | Real resume, synthetic sensitive docs | A failure leaks nothing real ([0010](docs/adr/0010-synthetic-sensitive-documents.md)) |

## Delivery

| Decision | Chosen | Why |
|---|---|---|
| CI/CD | GitHub Actions; deploy on green master | One workflow, tests gate the deploy ([0011](docs/adr/0011-github-oidc-continuous-deploy.md)) |
| AWS auth from CI | OIDC role, trusted only for the `production` environment (master only) | No stored keys; PRs and forks can't deploy |
| Pipeline's own permissions | Separate `SentinelResumeCiCd` stack, deployed by hand | CI can't widen its own role |
| What gets deployed | The artifacts the build job tested | No drift between tested and shipped |
| Post-deploy check | Live e2e, including real self sign-up | Proves the deployed site, not just the code |
| Rollback | CloudFormation on failed deploy; `git revert` otherwise | Simple; failed smoke tests fail the run loudly |
| Demo accounts | Public logins in the README, reset on every deploy | Instant try-out; the sensitive docs are synthetic |

## Monitoring

| Decision | Chosen | Turned down | Why |
|---|---|---|---|
| Metrics | Embedded Metric Format lines from the Lambdas | `PutMetricData`; log metric filters | No API calls, no extra IAM, and Lambda's JSON logging would hide our fields from metric filters |
| Request logging | One structured line per call from the Lambda (with `sub`, IP, user agent) | API Gateway access logs | Same data plus the verified user, without log-delivery permissions on the deploy role |
| Question logging | Full question text, 30 days, disclosed on the site | Not logging questions | After a public post, abuse and prompt-injection attempts are what you need to see |
| Alerts | CloudWatch alarms to an SNS email topic; a filter bypass alarms on the first event | Paging service | One maintainer; email is enough, and SNS works while SES is in the sandbox |

## Dependency security

| Decision | Chosen | Why |
|---|---|---|
| Vulnerability policy | Zero known advisories, any severity, dev tools included; CI fails otherwise | A public demo of a security product can't ship with known holes; a gate keeps it true after today |
| React Router | v7 (`react-router`) | v6 has open advisories (open redirect, constructor injection) with no v6 fix |
| Updates | Dependabot weekly (grouped minor/patch) and security updates; merged only through green PRs | Advisories land continuously; an audit gate without an update stream just blocks merges |
| Scanning | CodeQL default setup (extended queries), secret scanning with push protection | Covers our own code and committed secrets, not just dependencies |

A newly published advisory fails the next PR until it is fixed. That is intended.

## Known limits and next steps

- **Model over-refusal**: Nova Lite and Nova Pro refused some requests the caller *was* authorized
  for ("access his W-2" as admin). Haiku answers them, but still declines to print an SSN even to
  the admin. That is the model's own caution, not authorization, and acceptable for a public demo.
- **Policy text inside documents** is obeyed by the model. The W-2 used to say "only its owner can
  retrieve it" and Haiku refused the admin. Access rules live in the catalog, never in document
  text, and the prompt says access has already been enforced.
- **S3 Vectors connector** belongs upstream in `sentinel-engine` as an `s3vectors` extra.
- **SES sandbox**: notification email only reaches the verified admin address; recruiters are not
  emailed when a request is decided (they see it on the Request access page).
- **Fixed-window limits** allow a burst of up to 2x across a window boundary.
- **Admin overview** scans the identity table for active grants; fine for hundreds of users, not
  for millions.
- **Execution role breadth**: scoped by service and name prefix, but Cognito, API Gateway and
  CloudFront resources have generated IDs, so the execution role can manage any of those in the
  account (ADR 0012). Whoever can push to master can still change this app freely.
- **Shared demo accounts** can be abused (someone could change a password or enable MFA on one);
  every deploy resets them, and `scripts/test_users.py create` does it on demand.
- **Custom domain**: the site runs on the CloudFront domain; add a certificate and alias for a
  vanity URL.
