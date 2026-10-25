# Projects

## Sentinel: permission-aware retrieval for AI agents

Sentinel makes AI agents retrieve only what their human may read. Identity always comes from the transport (a stdio launcher or a verified JWT `sub`), never from tool arguments, and permissions are resolved live from SpiceDB, DynamoDB, SQLite or IAM and pushed into the vector query as a filter. Every returned chunk is re-checked against the caller's scope, and the system fails closed: missing tags, identity errors, bad tokens and unparseable results all deny.

Sentinel ships two adapters over one policy engine (sentinel-engine): an MCP server, and Amazon Bedrock AgentCore Gateway request/response interceptors with a TypeScript CDK construct. It has conformance, red-team and benchmark suites, and the red-team suite's leak rate must stay at zero in CI.

Source: https://github.com/aashishravindran/Sentinel

## This resume assistant

The assistant you are talking to is itself a Sentinel demo. Every signed-up recruiter can read the resume and these project notes. Sensitive documents (references, offer letter, salary history, tax forms) each carry their own access tag, so the vector search never returns them unless the owner has granted that recruiter access. Grants are time-boxed and revocation applies on the very next question. The stack is serverless on AWS: Cognito, API Gateway, Lambda, DynamoDB, S3 Vectors and Amazon Bedrock.

## Service Quotas AI agents (AWS)

Designed the Service Quotas team's first AI agents on Amazon Bedrock, using a supervisor/sub-agent model and a Bedrock Knowledge Base for retrieval, reaching 80% accuracy on automated responses. Also built the team's first MCP server for CloudWatch log analysis.
