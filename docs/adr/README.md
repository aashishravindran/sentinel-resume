# Architecture decision records

| # | Decision | Status |
|---|---|---|
| [0001](0001-s3-vectors-knowledge-store.md) | S3 Vectors as the knowledge store, queried directly | Accepted |
| [0002](0002-one-tag-per-sensitive-document.md) | Every sensitive document gets its own tag | Accepted |
| [0003](0003-expiring-grants.md) | Grants expire by being ignored, not by being deleted | Accepted |
| [0004](0004-named-admins-four-checks.md) | Admins are named in the repo, and every admin call passes four checks | Accepted |
| [0005](0005-http-api-not-agentcore-gateway.md) | A plain HTTP API, not the AgentCore Gateway | Accepted |
| [0006](0006-layered-rate-limits.md) | Layered rate limits, with a global cost breaker | Accepted |
| [0007](0007-same-origin-api.md) | Serve the API under /api on the site's CloudFront origin | Accepted |
| [0008](0008-model-sees-only-authorized-chunks.md) | The model only ever sees authorized chunks; the model is configurable | Accepted |
| [0009](0009-published-catalog.md) | Requests come from a published catalog, never from search results | Accepted |
| [0010](0010-synthetic-sensitive-documents.md) | Real resume, synthetic sensitive documents | Accepted |
| [0011](0011-github-oidc-continuous-deploy.md) | Continuous deploy from master through GitHub OIDC | Accepted |

Sentinel's own ADRs (identity from the transport, fail closed, tags over document IDs) apply here
unchanged: https://github.com/aashishravindran/Sentinel/tree/master/docs/adr
