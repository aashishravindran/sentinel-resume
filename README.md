# Sentinel Resume Assistant

A public, end-to-end demo of [Sentinel](https://github.com/aashishravindran/Sentinel): a recruiter signs up,
chats with an assistant about my resume, and the assistant can only retrieve what that recruiter may read.

| Document | Who can read it |
|---|---|
| Resume, project notes | every signed-up recruiter |
| Offer letter, salary history, references | only recruiters I approve, for a time I choose |
| W-2 tax form | only me: it cannot even be requested |

The sensitive documents are **synthetic** (fictional figures and people) so a leak could not hurt anyone,
but the system is built as if they were real.

## Try it out

Open **https://d381grodpq0ta7.cloudfront.net** and either sign up with your own email, or sign in as one
of these demo recruiters. Each one sees a different slice of the same documents:

| Email | Password | Can read |
|---|---|---|
| `basic.recruiter@example.com` | `Demo-Basic-2026` | resume, projects |
| `offer.recruiter@example.com` | `Demo-Offer-2026` | + offer letter |
| `full.recruiter@example.com` | `Demo-Full-2026` | + offer letter, salary history, references |

Nobody can read the W-2. Ask each of them the same questions and compare the answers and the
**"Why can't I see that?"** panel:

- *Where did Aashish study?*: everyone gets an answer
- *What base salary was in his 2024 offer?*: only the offer and full recruiters
- *What did his references say about him?*: only the full recruiter
- *What were his W-2 wages?*: nobody, whatever the wording

The demo accounts are shared, so they also share rate limits (20 questions an hour each). Their grants
expire periodically and are re-created by `scripts/test_users.py`. Sign up yourself to try the
request-access flow on the **Documents** page.

Beyond the resume, the assistant answers *why* questions about each project from its design records:
*Why does Sentinel take identity from the transport?*, *Why S3 Vectors instead of OpenSearch?*,
*How does VISION split work across agents?* See [Design library](#design-library).

## How access is enforced

```
recruiter ─► CloudFront ─► API Gateway (Cognito JWT, throttled) ─► Lambda
                                                                    │
     1. identity  = verified access token `sub` (never the request body)
     2. scope     = DynamoDB: base tags + unexpired grants, read live, nothing cached
     3. retrieval = S3 Vectors query with the scope as a metadata filter
     4. re-check  = every returned chunk's tags checked against the scope again
     5. answer    = Bedrock, given ONLY the chunks that survived 3 and 4
```

The model never sees a restricted chunk, so no prompt can talk it into revealing one. The chat page's
**"What the assistant saw"** panel shows your scope, the exact filter sent to the vector store, and how
many results each layer removed.

Built on [`sentinel-engine`](https://github.com/aashishravindran/sentinel-engine): `SentinelEngine`,
`TokenVerifier`, the shared filter builder, ingest stamping and the post-filter all come from it. This
repo adds an S3 Vectors knowledge connector and a DynamoDB identity connector with expiring grants.

### Request access

Each sensitive document carries its own tag (`doc_offer_letter`, ...). A recruiter requests one from the
**Documents** page with a reason; I get an email, and approving on `/admin` writes
`grant_doc_offer_letter = <expiry>` to their identity item. It applies on their next question and lapses on
its own. Revoking removes it immediately.

### Design library

Every recruiter can also read the design records of Aashish's public projects: this repo's README,
[FLOW.md](FLOW.md), [DECISIONS.md](DECISIONS.md) and ADRs (read in place), plus READMEs, architecture
notes, threat models and ADRs copied from his other public repos into `corpus/library/` by
`scripts/sync_library.py`. All are tagged `public`; a test fails if any of them quotes a figure or name
from a restricted document. Each chunk is prefixed with its project and document title (*Sentinel ADR
0002: Every failure denies > Decision*), so a "why" question finds the right project's ADR.
See [ADR 0013](docs/adr/0013-design-library.md).

```bash
uv run python -m scripts.sync_library   # refresh corpus/library/ from GitHub, then commit it
```

### Who can open `/admin`

Only people listed in [`infra/admins.json`](infra/admins.json), synced by `scripts/sync_admins.py`.
Nothing in the app can make someone an admin. Every admin call must pass four independent checks:

1. the access token carries the Cognito `admin` group
2. the `sub` is in the allowlist parameter (SSM), read on every call
3. the identity store gives them `sentinel_admin` (the engine's `TagAdminPolicy`)
4. they have an authenticator app (TOTP) enabled

### Rate limits and cost guards

| Layer | Limit |
|---|---|
| API Gateway stage | 10 req/s, burst 20 |
| Per recruiter | 20 questions/hour, 60/day; 5 access requests/day |
| Whole site | 1,500 model calls/day, then the demo "rests" until tomorrow |
| Sign-ups | 50/day (Cognito pre-sign-up trigger) + email verification |
| Lambda | reserved concurrency 5 (chat) and 3 (everything else) |
| Budget | AWS Budget email at 80% of $10/month |

Everything is serverless and on-demand (Cognito Lite, DynamoDB on-demand, S3 Vectors, Lambda, CloudFront),
so an idle month costs cents. A question costs roughly one Titan embedding plus one small-model call.

## Design docs

- [FLOW.md](FLOW.md): sequence diagrams for sign-up, chat, request, approval and admin setup
- [DECISIONS.md](DECISIONS.md): every choice, the alternatives and known limits
- [docs/adr/](docs/adr/README.md): architecture decision records

## Run it

Prerequisites: AWS credentials, a CDK-bootstrapped account, Node 22, [uv](https://docs.astral.sh/uv/).

```bash
uv sync
(cd frontend && npm ci && npm run build)
./scripts/build_lambda.sh
(cd infra && npm ci && npx cdk deploy SentinelResumeCiCd)   # boundary, asset bucket, scoped roles
(cd infra && npx cdk deploy SentinelResume --role-arn <ExecutionRoleArn output>)   # -c chatModelId=...

uv run python -m scripts.ingest_corpus       # embed corpus/ into S3 Vectors
# sign up on the site with the email in infra/admins.json, then:
uv run python -m scripts.sync_admins         # make the listed people admins
# on /admin, set up an authenticator app

uv run python -m scripts.e2e                 # live end-to-end check (creates and removes test users)
```

AWS sends a verification email to the admin address for SES (access-request notifications) and Cognito
sends one on sign-up.

### Model

`chatModelId` defaults to Claude Haiku 4.5 (`us.anthropic.claude-haiku-4-5-20251001-v1:0`), called through Bedrock with the
Lambda's IAM role (no API key). Any Bedrock model or inference profile works: `-c chatModelId=us.amazon.nova-lite-v1:0`.

## Develop

```bash
uv run pytest                 # unit, workflow, trigger and red-team tests (moto + in-memory S3 Vectors)
uv run ruff check . && uv run pyright
(cd infra && npm test)
SITE=https://<your-site> npm --prefix frontend run dev   # local UI against a deployed API
```

The red-team suite sends adversarial questions (prompt injection, filter injection, user IDs in the body,
forged/expired/ID tokens, a store that ignores the filter) and asserts that no restricted text ever reaches
the model.

## CI/CD

Every push and pull request runs the tests, builds the SPA and Lambda bundle, and synthesizes the stack.
`master` only changes through a squash-merged pull request whose `python` and `build` checks passed
(a repository ruleset with no bypass, not even for admins; no force pushes or deletion). The merge to
`master` then deploys automatically:

```
push to master ─► tests + build ─► deploy (GitHub OIDC role, no stored keys, scoped to this stack)
                                     ├─ cdk deploy SentinelResume (the tested artifacts)
                                     ├─ re-embed corpus/
                                     ├─ reset the demo accounts above
                                     └─ live e2e: sign-up, chat, denial, request, approve, expiry
```

One-time setup (already done for this deployment):

```bash
(cd infra && npx cdk deploy SentinelResumeCiCd)   # OIDC provider, deploy + execution roles, boundary
gh secret set AWS_DEPLOY_ROLE_ARN --env production    # paste the DeployRoleArn output
gh secret set CFN_EXEC_ROLE_ARN --env production      # paste the ExecutionRoleArn output
# GitHub environment "production", deployment branches: master only
```

What the pipeline can do to the AWS account, at most:

| Role | Can | Cannot |
|---|---|---|
| GitHub deploy role (OIDC, `production` environment on master only) | change sets on the `SentinelResume` stack; upload to this app's asset bucket; pass one role to CloudFormation; the ingest, demo-user and e2e calls (Cognito admin calls only on the pool tagged `app=sentinel-resume`) | assume the CDK bootstrap roles; touch any other stack; create or edit IAM |
| CloudFormation execution role | the services this stack uses, on `SentinelResume-*` names; create roles named `SentinelResume-*` **only** with the boundary attached | create a role without the boundary, remove a boundary, attach any managed policy but Lambda basic execution |
| Permissions boundary on every app role | the app's tables, vector index, Bedrock, its SSM parameter, SES, its buckets, CloudFront invalidations | anything else, whatever policy a template attaches |

Repository settings: Actions limited to GitHub-owned actions plus `aws-actions/configure-aws-credentials`
and `astral-sh/setup-uv`, all pinned to commit SHAs (enforced); workflows from every outside
contributor need approval; the default `GITHUB_TOKEN` is read-only.

Role names are generated, the ARNs live in GitHub environment secrets, the account ID is masked in the
(public) logs, actions are pinned to commit SHAs, and dependencies install before credentials exist.
See [ADR 0011](docs/adr/0011-github-oidc-continuous-deploy.md) and [ADR 0012](docs/adr/0012-scoped-deploy-roles.md).

## License

Elastic License 2.0, matching Sentinel.
