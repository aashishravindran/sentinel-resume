# 0008. Infrastructure never creates a knowledge base implicitly

## Context

A knowledge base's vector store can bill while idle (OpenSearch Serverless keeps minimum
capacity running). The original plan migrated the demo to a newly created Managed KB.

## Decision

The demo stack requires a knowledge base to be named (`-c knowledgeBaseId=... -c
knowledgeBaseKind=standard|managed-kb`) or explicitly requested (`-c createManagedKb=true`).
Provisioned concurrency is opt-in (`provisionedConcurrency`, default 0). Gateway behavior is
proven locally by the conformance and red-team suites, which drive the real interceptor
handlers against a stub knowledge base that evaluates Bedrock filter JSON.

## Consequences

`cdk synth` and the template tests run in CI with no AWS account. Live latency through a
deployed gateway is not yet measured (`docs/benchmarks.md` says so).
