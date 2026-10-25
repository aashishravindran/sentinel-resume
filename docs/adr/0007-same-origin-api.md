# 0007. Serve the API under /api on the site's CloudFront origin

## Context

The SPA needs the API URL and Cognito IDs, and the browser needs to reach the API.

## Decision

CloudFront serves the SPA from a private S3 bucket and forwards `/api/*` to the HTTP API (caching
disabled, all viewer headers except Host). The deployment writes `config.json` (region, pool and
client IDs) next to the bundle, and the SPA reads it at boot.

## Consequences

- Same origin, so no CORS configuration to get wrong.
- The same frontend build works for any deployment.
- SPA routes are rewritten to `index.html` by a CloudFront Function, not by custom error responses,
  which would also have turned the API's 403s into HTML.
