# SentinelGateway (AWS CDK, TypeScript)

An Amazon Bedrock AgentCore Gateway with Sentinel as its policy decision point.

- **Inbound:** the gateway's custom JWT authorizer accepts tokens from your OIDC issuer.
- **REQUEST interceptor:** re-verifies the token, resolves the caller's tags from DynamoDB,
  and rebuilds every tool call's arguments. A Managed KB filter is written, never merged.
- **RESPONSE interceptor:** hides `filter`, `userContext` and the principal envelope from
  `tools/list`, then re-checks every returned chunk against the caller's live tags.
- **Knowledge:** a Bedrock Managed KB through the native connector, or any standard Bedrock KB
  through Sentinel's Lambda target.

```ts
import { SentinelGateway } from './lib';

const gateway = new SentinelGateway(this, 'Sentinel', {
  oidc: {
    discoveryUrl: `${issuer}/.well-known/openid-configuration`,
    issuer,
    jwksUri: `${issuer}/.well-known/jwks.json`,
    allowedClients: [appClientId],          // or allowedAudience for Okta / Auth0 / Entra
  },
  knowledgeBase: { kind: 'managed-kb', knowledgeBaseId: 'ABCDEFGHIJ' },
  // knowledgeBase: { kind: 'lambda-target', knowledgeBaseId: 'ABCDEFGHIJ' },
  identityTable,                            // partition key user_id (= token sub), attribute tags (SS)
  code: lambda.Code.fromAsset('../../build/lambda'),
  provisionedConcurrency: 1,                // optional; default 0 (no idle cost)
});
```

| Prop | Default | Notes |
|---|---|---|
| `oidc` | required | Discovery URL for the gateway authorizer; issuer and JWKS URI for the interceptors |
| `knowledgeBase` | required | `managed-kb` (native connector) or `lambda-target` (standard KB) |
| `identityTable` | required | Functions get `dynamodb:GetItem` on this table only |
| `code` | required | Built by `scripts/build_lambda.sh` (arm64, no Docker) |
| `provisionedConcurrency` | `0` | Warm instances per function; billed while idle |
| `memorySize` | `1024` | MB per function |
| `forwardUserContext` (managed-kb) | `false` | Also send `userContext.userId = sub`, for KBs with native ACLs |

## What it creates

- `AWS::BedrockAgentCore::Gateway` with one REQUEST and one RESPONSE interceptor, both
  receiving request headers
- Two or three ARM64 Python 3.14 functions with a `live` alias, JSON logs at INFO, and a role
  each, scoped to its own log group
- A Secrets Manager secret for the principal envelope key
- A gateway target: the managed KB connector, or the `secure_search` Lambda target

No knowledge base, vector store or warm capacity is created unless you ask for it
([ADR 0008](../../docs/adr/0008-no-implicit-knowledge-base.md)).

## Demo stack

`bin/app.ts` adds a Cognito user pool and app client and a DynamoDB identity table:

```bash
../../scripts/build_lambda.sh
npm ci
npx cdk deploy -c knowledgeBaseId=<id> -c knowledgeBaseKind=standard   # or managed-kb
# Create a Managed KB too, knowing it bills while it exists:
npx cdk deploy -c createManagedKb=true
```

Load identities with `uv run python scripts/sync_identity.py --table <IdentityTableName>
--user-pool-id <UserPoolId> --apply`.

Each interceptor decision is one JSON log record. To query them in CloudWatch Logs Insights:

```
fields @timestamp, user, tags, tool, decision, reason
| filter decision = "deny"
| sort @timestamp desc
```

## Checks

`npm test` (jest template assertions) and `npx cdk synth` with cdk-nag AwsSolutions. Every
acknowledged finding carries its reason in code.
