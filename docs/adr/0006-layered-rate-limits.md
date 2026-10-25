# 0006. Layered rate limits, with a global cost breaker

## Context

A public sign-up page in front of a paid model invites abuse: scripted sign-ups, one user hammering
chat, or many users together running up the bill.

## Decision

Limits at every layer, each cheap:

| Layer | Limit | Where |
|---|---|---|
| API stage | 10 req/s, burst 20 | API Gateway |
| Per user | 20 chats/hour, 60/day; 5 requests/day | DynamoDB fixed windows |
| Site | 1,500 model calls/day | DynamoDB counter checked before Bedrock |
| Sign-ups | 50/day | Cognito pre-sign-up trigger |
| Concurrency | 5 chat, 3 other | Lambda reserved concurrency |
| Spend | email at 80% of $10/month | AWS Budget |

The limiter is one conditional `UpdateItem` (`ADD hits :1` if `hits < limit`) per window key with
a TTL. Questions with no authorized relevant chunks never call the model and do not count against
the site budget.

## Consequences

- No WAF ($5+/month idle). The stage throttle plus per-user quotas cover this demo's threat level.
- Fixed windows allow up to 2x a limit across a window boundary. Acceptable here.
- When the site budget is spent, chat returns 503 "resting" until the next UTC day.
