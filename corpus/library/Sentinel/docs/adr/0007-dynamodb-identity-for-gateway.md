# 0007. DynamoDB identity for Gateway mode; SpiceDB later

## Context

The interceptors must reach the identity store from Lambda on every call. SpiceDB would need
hosting (AuthZed Cloud or a self-hosted cluster in a VPC, with VPC-attached Lambdas and their
cold-start cost).

## Decision

The CDK construct uses a DynamoDB table keyed by the token's `sub` with a `tags` string set.
Lambdas stay outside a VPC and hold `dynamodb:GetItem` on that table only. The MCP server
keeps SpiceDB as its relationship-based (ReBAC) option.

## Consequences

Gateway mode resolves flat tags, not relationship inheritance, until SpiceDB support lands in
the construct. The engine already supports both stores, so this is an infrastructure gap only.
`scripts/sync_identity.py` loads an org file into the table, translating usernames to
Cognito `sub` values.
