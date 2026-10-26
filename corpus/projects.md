# Projects

Aashish's public projects, newest first. Each has its own README and architecture notes; Sentinel
and this resume assistant also have architecture decision records (ADRs) that explain why each
design choice was made. All code is on GitHub: https://github.com/aashishravindran

## Sentinel: permission-aware retrieval for AI agents (2026)

Sentinel makes AI agents retrieve only what their human may read. Identity always comes from the
transport (a stdio launcher or a verified JWT `sub`), never from tool arguments, and permissions are
resolved live from SpiceDB, DynamoDB, SQLite or IAM and pushed into the vector query as a filter.
Every returned chunk is re-checked against the caller's scope, and the system fails closed: missing
tags, identity errors, bad tokens and unparseable results all deny.

- Two adapters over one policy engine: an MCP server, and Amazon Bedrock AgentCore Gateway
  request/response interceptors with a TypeScript CDK construct.
- v2 fixed v1's biggest flaw: v1 trusted a model-supplied `user_id`; v2 binds identity to the
  transport (Sentinel ADR 0001).
- Conformance, red-team and benchmark suites; the red-team leak rate must stay at zero in CI.
- Live-tested end to end against Cognito and AgentCore Gateway on AWS.
- Stack: Python, MCP, SpiceDB, DynamoDB, Bedrock Knowledge Bases, AgentCore Gateway, AWS CDK
  (TypeScript). Elastic License 2.0.
- Source: https://github.com/aashishravindran/Sentinel

## sentinel-engine (2026)

The policy decision point extracted from Sentinel so any Python RAG pipeline can use it: verify an
OIDC token, resolve which documents the user may read right now, turn that into a filter inside the
vector query, re-check every result, and fail closed. Versioned by git tag (v0.1.0).

- Source: https://github.com/aashishravindran/sentinel-engine

## This resume assistant: sentinel-resume (2026)

The assistant you are talking to is itself a Sentinel demo. Every signed-up recruiter can read the
resume, these project notes and each project's design documents. Sensitive documents (references,
offer letter, salary history, tax form) each carry their own access tag, so the vector search never
returns them unless Aashish has granted that recruiter access; grants are time-boxed and revocation
applies on the very next question.

- Serverless on AWS: Cognito, API Gateway HTTP API, Lambda, DynamoDB, S3 Vectors, Bedrock (Titan
  embeddings, Claude Haiku 4.5), CloudFront.
- Named admins with four independent checks (group, allowlist, admin tag, TOTP MFA).
- Layered rate limits and a site-wide daily model budget.
- CI/CD from GitHub Actions through OIDC: a scoped deploy role, a scoped CloudFormation execution
  role and a permissions boundary on every app role; master is PR-only with required checks.
- Design records: README, Flows, Decisions and ADRs 0001 to 0012.
- Source: https://github.com/aashishravindran/sentinel-resume

## VISION: multi-agent finance research (2026)

Verified Intelligence on Sectors, Instruments, Opportunities and Narratives. A chat UI where an
orchestrator agent delegates to four specialist sub-agents (sector, stock, screener, news) that run
in parallel, pull live market data, compute technical indicators, render charts and return one cited
answer. Built to be honest about what it doesn't know: tier-gated data falls back to web search, and
errors surface as visible chips rather than guesses.

- Stack: OpenAI Agents SDK (gpt-5 orchestrator, gpt-5-mini specialists with structured output),
  FastAPI with SSE streaming, SQLite cache, Next.js 15 / React 19 / Tailwind, Plotly charts,
  Financial Modeling Prep, GDELT news.
- Source: https://github.com/aashishravindran/VISION

## Super Duper Chat Bot: multi-agent assistant (2026)

A LangGraph supervisor routes each message to a hybrid-RAG agent over the resume (BM25 + ChromaDB,
reciprocal rank fusion, cross-encoder reranking), a GitHub agent that explores repositories through
the GitHub MCP server, or a direct answer; a verifier node checks answer quality and retries once.
Responses stream as typed Server-Sent Events, and the FastAPI app is packaged for AWS Lambda with
Mangum.

- Source: https://github.com/aashishravindran/super-duper-chat-bot

## ProductionRAG: resume chat built to production standards (2026)

A RAG application over the resume and project write-ups: embedding-based query routing (prototype
vectors replaced an LLM classifier that added 5 to 10 seconds per query), metadata filters, hybrid
BM25 + vector search, RRF fusion, cross-encoder reranking and HyDE-style hypothetical questions at
ingest. Runs locally on Ollama and ChromaDB. A separate document checks its design choices against
published research.

- Source: https://github.com/aashishravindran/ProductionRAG

## Agentic Fitness App and SuperSetUI (2026)

A fitness coaching platform on LangGraph: a supervisor routes to specialist coaches (Iron, Yoga,
HIIT, Kickboxing), each grounded by RAG over creator-written markdown embedded locally with Ollama
into ChromaDB. It tracks fatigue (time-based decay, RPE-based accumulation, rest-day recovery) and
keeps per-user history in SQLite checkpoints, behind a FastAPI + WebSocket API for live workouts.
SuperSetUI is its React front end (Vite, TypeScript, Tailwind, Framer Motion).

- Source: https://github.com/aashishravindran/agentic-fitness-app and
  https://github.com/aashishravindran/SuperSetUI

## Smaller projects

- AiAgents: an agent built with the Strands framework and MCP tools.
- steal-my-agents: reusable Claude Code sub-agents with an installer.
- aashishravindran.github.io: a portfolio site in vanilla HTML, CSS and JavaScript.
- Earlier (2019): human activity recognition (Kotlin), posture recognition (MATLAB), packet loss
  and CRC analysis (Python).

## Work projects at AWS (Service Quotas)

- Service Quotas AI agents: the team's first AI agents on Amazon Bedrock, using a supervisor /
  sub-agent model and a Bedrock Knowledge Base for retrieval, reaching 80% accuracy on automated
  responses.
- The team's first MCP server, for CloudWatch log analysis (a 25% reduction in operational pain).
- A scalable data plane on DynamoDB that cut service-team onboarding time by 80%.
- Context based quotas, asynchronous quota-utilization reporting (under 2 seconds for 99% of
  accounts) and region build automation.
