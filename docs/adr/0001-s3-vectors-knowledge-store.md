# 0001. S3 Vectors as the knowledge store, queried directly

## Context

The demo is public and mostly idle. The vector store must support a metadata filter (so the
caller's scope can go into the query, per Sentinel ADR 0003) and should cost nothing while nobody is
using it. Options:

1. Bedrock Knowledge Base on OpenSearch Serverless (what `Sentinel/scripts/setup_aws.py` creates).
2. Bedrock Managed Knowledge Base (`Sentinel/infra/cdk/lib/managed-kb.ts`).
3. Bedrock Knowledge Base backed by S3 Vectors.
4. S3 Vectors, queried directly from the Lambda.

## Decision

Option 4. A ~100-line `S3VectorsKnowledge` implements sentinel-engine's `KnowledgeConnector`:
ingest chunks the text, embeds each chunk with Titan Text Embeddings v2, stamps metadata with the
engine's `stamp_metadata`, and calls `PutVectors`. Search embeds the question and calls
`QueryVectors` with `queryMode=ENHANCED` (filter applied before the similarity search) and a filter
from the engine's `build_chroma_where`. S3 Vectors' filter language is the same `$or`/`$eq` syntax.

## Consequences

- No idle cost: OpenSearch Serverless and the managed KB bill per hour (Sentinel ADR 0008).
- No ingestion jobs to wait on; re-ingest is a script run (`scripts/ingest_corpus.py`).
- We own chunking. Chunks are section-aligned and prefixed with "Title > Section" so short
  sections (education, skills) embed with their context. The first, paragraph-only version scored
  the education chunk at 0.10 for "where did he study"; the prefixed one scores 0.63.
- No hybrid (BM25) search or reranking. Fine for a six-document corpus.
- `text`, `title` and `doc_id` are declared non-filterable, so only `tag_*` keys and `access_tags`
  count against the 2 KB filterable-metadata limit.
- Candidate to upstream into sentinel-engine as an `s3vectors` extra.
