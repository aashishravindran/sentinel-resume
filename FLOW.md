# Flows

How each request moves through the system. Diagrams are Mermaid and render on GitHub. The reasoning
behind each choice is in [DECISIONS.md](DECISIONS.md).

## Components

```mermaid
flowchart LR
  B[Browser SPA] -->|static files| CF[CloudFront]
  B -->|/api/*| CF
  CF --> S3[(S3: site bucket)]
  CF --> API[API Gateway HTTP API<br/>Cognito JWT authorizer<br/>10 rps throttle]
  B <-->|sign-up, sign-in, TOTP| COG[Cognito user pool]
  COG -->|pre-sign-up| T1[Trigger: daily cap]
  COG -->|post-confirmation| T2[Trigger: create identity item]
  API -->|POST /api/chat| CHAT[Chat Lambda]
  API -->|everything else| APIFN[API Lambda]
  CHAT --> ID[(DynamoDB identity)]
  CHAT --> RL[(DynamoDB rate limits)]
  CHAT --> VEC[(S3 Vectors index)]
  CHAT --> BR[Bedrock: Titan embed + chat model]
  APIFN --> ID
  APIFN --> REQ[(DynamoDB requests)]
  APIFN --> AUD[(DynamoDB audit)]
  APIFN --> SSM[(SSM admin allowlist)]
  APIFN --> SNS[SNS alerts topic: email admin]
```

## 1. Sign-up

```mermaid
sequenceDiagram
  participant R as Recruiter
  participant C as Cognito
  participant P as Pre-sign-up trigger
  participant Q as Post-confirmation trigger
  participant D as Identity table
  R->>C: signUp(email, password)
  C->>P: check
  P->>P: global#signup counter < 50 today?
  P-->>C: ok (or "sign-ups paused")
  C->>R: email verification code
  R->>C: confirmSignUp(code)
  C->>Q: confirmed
  Q->>D: put {user_id: sub, tags: {public}, email}<br/>only if the item doesn't exist
  R->>C: signIn → access token (1 hour)
```

The trigger never overwrites an existing item, so re-confirming can't reset an admin's tags.

## 2. Chat: the Sentinel path

```mermaid
sequenceDiagram
  participant R as Recruiter
  participant G as API Gateway
  participant L as Chat Lambda
  participant D as Identity table
  participant V as S3 Vectors
  participant M as Bedrock model
  R->>G: POST /api/chat {question} + Bearer access token
  G->>G: JWT signature, issuer, client
  G->>L: event
  L->>L: TokenVerifier: signature, exp, client_id, token_use=access → sub
  L->>L: rate limits: user hour, user day
  L->>D: GetItem(sub), consistent
  D-->>L: tags + grant_* attributes
  L->>L: scope = tags ∪ unexpired grants − sentinel_admin<br/>(empty scope → 403, store never queried)
  L->>V: QueryVectors(embed(question), filter = $or of tag_<scope>)
  V-->>L: top-k chunks (only those matching the filter)
  L->>L: authorize_chunks: re-check every chunk's tags
  L->>L: filter_relevant(score ≥ 0.05)
  alt nothing left
    L-->>R: NO_RELEVANT_ACCESS + "request access" pointer (no model call)
  else chunks left
    L->>L: site budget counter < 1,500 today?
    L->>M: system prompt + <documents> (authorized chunks only) + question
    M-->>L: answer, or NO_ANSWER
    alt NO_ANSWER
      L-->>R: same reply as "nothing left" (no hint that anything exists)
    else answer
      L-->>R: answer, sources it actually cited, trace
    end
  end
```

The `trace` returned to the page holds the scope, the exact filter, how many chunks were retrieved,
how many the re-check removed, how many were below the relevance cutoff, and the titles sent to the
model. The "Why can't I see that?" panel renders it.

## 3. Request access

```mermaid
sequenceDiagram
  participant R as Recruiter
  participant L as API Lambda
  participant Q as Requests table
  participant A as Audit table
  participant E as SNS alerts topic
  R->>L: GET /api/catalog
  L-->>R: documents, each with has_access / requestable / request status
  R->>L: POST /api/requests {tag, reason}
  L->>L: tag requestable in catalog? not already held?
  L->>L: rate limit: 5 requests/day
  L->>Q: put request_id = sub:tag, status=pending<br/>only if none pending for (sub, tag)
  L->>A: audit "request"
  L->>E: email admin: who, which doc, reason, link to /admin
  L-->>R: request (pending)
```

## 4. Approve, deny, revoke

```mermaid
sequenceDiagram
  participant AD as Admin
  participant L as API Lambda
  participant S as SSM allowlist
  participant C as Cognito
  participant Q as Requests table
  participant D as Identity table
  AD->>L: POST /api/admin/requests/{id}/approve {minutes}
  L->>L: 1. token has cognito:groups ∋ admin
  L->>S: 2. sub in allowlist?
  L->>D: 3. tags ∋ sentinel_admin? (engine.is_admin)
  L->>C: 4. TOTP enabled? (AdminGetUser)
  Note over L: any check fails → 403 + audit "admin_denied"
  L->>Q: status pending → approved, expires_at (conditional)
  L->>D: SET grant_<tag> = expires_at
  L-->>AD: approved
```

- **Deny** flips the status to `denied`. The recruiter may file again later.
- **Revoke** runs `REMOVE grant_<tag>` and takes effect on the recruiter's next question.
- **Expiry** needs no action: `get_tags` ignores a grant whose expiry has passed.

## 5. Becoming an admin

```mermaid
flowchart LR
  F[infra/admins.json<br/>committed emails] --> S[scripts/sync_admins.py<br/>needs AWS credentials]
  S --> G[Cognito group: admin]
  S --> T[Identity: sentinel_admin + all doc_* tags]
  S --> P[SSM: allowlist of subs]
  U[Admin in browser] --> M[/admin page: set up authenticator/]
  M --> C[Cognito TOTP enabled]
```

All four outputs are needed. Removing an email and re-running the script removes the group, the tags
and the allowlist entry.

## 6. Ingest (operator)

```mermaid
flowchart LR
  C[corpus/*.md] --> K[catalog.json: doc_id, title, tag]
  K --> X[chunk_text: section-aligned, Title > Section prefix]
  X --> E[Titan embed]
  E --> P[PutVectors: metadata = stamp_metadata tags + doc_id, title, text]
```

`stamp_metadata` (sentinel-engine) writes `tag_<t>: true` and `access_tags`, and rejects reserved
tags and caller-supplied `tag_*` keys. Re-ingesting a document deletes its old chunk keys first.

## Failure behavior

| Failure | Result |
|---|---|
| Missing, expired, forged or ID token | 401 |
| Identity item missing or no tags | 403, vector store never queried |
| DynamoDB or SSM error on an admin check | that check fails → 403 |
| Vector store ignores the filter | post-check removes the extra chunks |
| Over a per-user limit | 429 with `Retry-After` |
| Site model budget spent | 503 "resting" until the next UTC day |
| Audit write fails | logged to CloudWatch; the request still completes |
