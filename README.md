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
**"Why can't I see that?"** panel shows your scope, the exact filter sent to the vector store, and how
many results each layer removed.

Built on [`sentinel-engine`](https://github.com/aashishravindran/sentinel-engine): `SentinelEngine`,
`TokenVerifier`, the shared filter builder, ingest stamping and the post-filter all come from it. This
repo adds an S3 Vectors knowledge connector and a DynamoDB identity connector with expiring grants.

### Request access

Each sensitive document carries its own tag (`doc_offer_letter`, ...). A recruiter requests one from the
**Request access** page with a reason; I get an email, and approving on `/admin` writes
`grant_doc_offer_letter = <expiry>` to their identity item. It applies on their next question and lapses on
its own. Revoking removes it immediately.

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
(cd infra && npm ci && npx cdk deploy)       # -c chatModelId=... -c adminEmail=...

uv run python -m scripts.ingest_corpus       # embed corpus/ into S3 Vectors
# sign up on the site with the email in infra/admins.json, then:
uv run python -m scripts.sync_admins         # make the listed people admins
# on /admin, set up an authenticator app

uv run python -m scripts.e2e                 # live end-to-end check (creates and removes test users)
```

AWS sends a verification email to the admin address for SES (access-request notifications) and Cognito
sends one on sign-up.

### Model

`chatModelId` defaults to `us.amazon.nova-lite-v1:0`. To use Claude Haiku, enable it under Bedrock model
access, then deploy with `-c chatModelId=us.anthropic.claude-haiku-4-5-20251001-v1:0`.

## Develop

```bash
uv run pytest                 # unit, workflow and red-team tests (moto + in-memory S3 Vectors)
uv run ruff check . && uv run pyright
(cd infra && npm test)
SITE=https://<your-site> npm --prefix frontend run dev   # local UI against a deployed API
```

The red-team suite sends adversarial questions (prompt injection, filter injection, user IDs in the body,
forged/expired/ID tokens, a store that ignores the filter) and asserts that no restricted text ever reaches
the model.

## License

Elastic License 2.0, matching Sentinel.
