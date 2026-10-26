# Sentinel — Connector Reference

Sentinel is built around two pluggable connector interfaces:

- **Identity Connector** — answers "what tags does this user hold?"
- **Knowledge Connector** — answers "which documents match this tag set?"

Mix and match any identity + knowledge pair. The combination is set entirely through environment variables; no code changes are required.

---

## Identity Connectors

### SQLite (`sqlite`)

Local-first identity store. Reads from a single `permissions` table — ideal for development, CI, and unit testing.

**Install:** included in the base install (`uv sync`).

**Schema:**
```sql
CREATE TABLE permissions (
    user_id TEXT NOT NULL,
    tag     TEXT NOT NULL,
    PRIMARY KEY (user_id, tag)
);

-- Example rows
INSERT INTO permissions VALUES ('alice', 'finance');
INSERT INTO permissions VALUES ('alice', 'public');
INSERT INTO permissions VALUES ('bob',   'engineering');
```

**Initialise the DB:**
```bash
python scripts/init_db.py
```

**Environment variables:**

| Variable | Required | Default | Description |
|---|---|---|---|
| `SENTINEL_IDENTITY_STORE` | ✅ | — | Must be `sqlite` |
| `SQLITE_DB_PATH` | — | `./data/permissions.db` | Path to the SQLite file |

**MCP config snippet:**
```json
"env": {
  "SENTINEL_IDENTITY_STORE": "sqlite",
  "SQLITE_DB_PATH": "/absolute/path/to/Sentinel/data/permissions.db"
}
```

---

### DynamoDB (`dynamodb`)

AWS-native identity store. A single `GetItem` call per query — sub-10ms at any scale.

**Install:** included in base install (uses `aioboto3`).

**Table schema:**

| Attribute | Type | Notes |
|---|---|---|
| `user_id` | String (PK) | Partition key |
| `tags` | String Set | e.g. `{"finance", "public"}` |

**Create the table:**
```bash
aws dynamodb create-table \
  --table-name sentinel-identity \
  --attribute-definitions AttributeName=user_id,AttributeType=S \
  --key-schema AttributeName=user_id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST
```

**Seed a user:**
```bash
aws dynamodb put-item \
  --table-name sentinel-identity \
  --item '{"user_id": {"S": "alice"}, "tags": {"SS": ["finance", "public"]}}'
```

**Environment variables:**

| Variable | Required | Default | Description |
|---|---|---|---|
| `SENTINEL_IDENTITY_STORE` | ✅ | — | Must be `dynamodb` |
| `DDB_TABLE_NAME` | ✅ | — | DynamoDB table name |
| `AWS_REGION` | — | `us-east-1` | AWS region |
| `AWS_PROFILE` | — | `default` | AWS credentials profile |

**MCP config snippet:**
```json
"env": {
  "SENTINEL_IDENTITY_STORE": "dynamodb",
  "DDB_TABLE_NAME": "sentinel-identity",
  "AWS_REGION": "us-east-1",
  "AWS_PROFILE": "your-profile"
}
```

---

### IAM (`iam`)

AWS-native identity connector that reads tags directly from IAM users or roles — no separate identity table required. Each AWS tag is mapped to a Sentinel permission tag; the format is controlled by `IAM_TAG_FORMAT`.

**Install:** included in base install (uses `aioboto3`).

**Tag format options:**

| `IAM_TAG_FORMAT` | IAM tag | Sentinel tag | Document `access_tags` |
|---|---|---|---|
| `value` (default) | `Project = finance` | `finance` | `["finance"]` |
| `key` | `Project = finance` | `Project` | `["Project"]` |
| `key:value` | `Project = finance` | `Project:finance` | `["Project:finance"]` |

Choose `value` for short, readable tags when key collisions aren't a concern. Choose `key:value` for full qualification — `Project:finance` will never match a user with `Team = finance`.

**Tag your IAM principals:**
```bash
aws iam tag-user --user-name alice \
  --tags Key=Project,Value=finance Key=Team,Value=platform

aws iam tag-role --role-name data-analyst \
  --tags Key=Project,Value=finance
```

**Optional prefix scoping** — set `IAM_TAG_KEY_PREFIX` to restrict which tags are used and strip the prefix before formatting:

```bash
# Tag the principal
aws iam tag-user --user-name alice --tags Key=Sentinel/Project,Value=finance

# Config
IAM_TAG_KEY_PREFIX=Sentinel/
IAM_TAG_FORMAT=value
# → Sentinel tag: "finance"  (prefix stripped)
```

**Environment variables:**

| Variable | Required | Default | Description |
|---|---|---|---|
| `SENTINEL_IDENTITY_STORE` | ✅ | — | Must be `iam` |
| `IAM_PRINCIPAL_TYPE` | — | `user` | `user` (calls `list_user_tags`) or `role` (calls `list_role_tags`) |
| `IAM_TAG_FORMAT` | — | `value` | `value`, `key`, or `key:value` |
| `IAM_TAG_KEY_PREFIX` | — | `""` | Only include tags whose key starts with this prefix; strip it before formatting |
| `AWS_REGION` | — | `us-east-1` | AWS region |
| `AWS_PROFILE` | — | `default` | AWS credentials profile |

**MCP config snippet:**
```json
"env": {
  "SENTINEL_IDENTITY_STORE": "iam",
  "IAM_PRINCIPAL_TYPE": "user",
  "IAM_TAG_FORMAT": "value",
  "AWS_REGION": "us-east-1",
  "AWS_PROFILE": "your-profile"
}
```

---

### SpiceDB (`spicedb`)

[ReBAC](https://zanzibar.academy) identity connector backed by [SpiceDB](https://github.com/authzed/spicedb) — the open-source implementation of Google's Zanzibar model. Resolves user permissions via `LookupResources`, enabling deep relationship hierarchies (e.g. *user → team → project*) in addition to flat tag lists.

**Install:**
```bash
uv pip install "authzed>=0.8"
# or add to your project:
uv add --optional spicedb authzed
```

**Install SpiceDB + zed CLI (macOS):**
```bash
brew install authzed/tap/spicedb authzed/tap/zed
```

**Minimal schema** (`spicedb/schema.zed`):
```
definition user {}

definition tag {
    relation member: user
    permission access = member
}
```

**Start SpiceDB locally** (in-memory, no TLS):
```bash
# One-shot: starts SpiceDB and seeds test users
./spicedb/start.sh

# Or manually:
spicedb serve-testing --grpc-addr=":50051" &
./spicedb/seed.sh localhost:50051 your-token
```

**Write the schema and seed relationships:**
```bash
zed --endpoint=localhost:50051 --token=your-token --insecure schema write spicedb/schema.zed
zed --endpoint=localhost:50051 --token=your-token --insecure relationship touch tag:finance member user:alice
zed --endpoint=localhost:50051 --token=your-token --insecure relationship touch tag:public  member user:alice
```

**Environment variables:**

| Variable | Required | Default | Description |
|---|---|---|---|
| `SENTINEL_IDENTITY_STORE` | ✅ | — | Must be `spicedb` |
| `SPICEDB_ENDPOINT` | ✅ | — | gRPC target, e.g. `localhost:50051` |
| `SPICEDB_TOKEN` | ✅ | — | Pre-shared key / bearer token |
| `SPICEDB_TLS` | — | `true` | Set `false` for local serve-testing |
| `SPICEDB_RESOURCE_TYPE` | — | `tag` | SpiceDB object type representing a tag |
| `SPICEDB_PERMISSION` | — | `access` | Permission name checked via LookupResources |
| `SPICEDB_USER_TYPE` | — | `user` | SpiceDB subject type for users |

**MCP config snippet:**
```json
"env": {
  "SENTINEL_IDENTITY_STORE": "spicedb",
  "SPICEDB_ENDPOINT": "localhost:50051",
  "SPICEDB_TOKEN": "your-preshared-key",
  "SPICEDB_TLS": "false"
}
```

**Extra MCP tool (SpiceDB only):**

`list_user_relationships(user_id)` (admin only) lists all raw SpiceDB relationship tuples for a user. Useful for auditing and debugging. Returns an error if called against a non-SpiceDB identity store.

---

## Knowledge Connectors

### ChromaDB (`chroma`)

Open-source local vector database. Uses `all-MiniLM-L6-v2` embeddings by default and cosine similarity for retrieval.

**Install:** included in base install (`uv sync`).

**How tags are stored:** each access tag is stored as a boolean metadata field `tag_<name>: True`. A comma-separated `access_tags` field is also stored for human-readable inspection.

```
doc metadata: {"tag_finance": True, "tag_engineering": True, "access_tags": "finance,engineering", "title": "..."}
```

**Create the data directory:**
```bash
mkdir -p data/chroma
```

**Environment variables:**

| Variable | Required | Default | Description |
|---|---|---|---|
| `SENTINEL_KNOWLEDGE_STORE` | ✅ | — | Must be `chroma` |
| `CHROMA_PATH` | — | `./data/chroma` | Directory for ChromaDB persistence |
| `CHROMA_COLLECTION` | — | `sentinel` | Collection name |
| `EMBEDDING_MODEL` | — | `all-MiniLM-L6-v2` | HuggingFace sentence-transformers model |

**MCP config snippet:**
```json
"env": {
  "SENTINEL_KNOWLEDGE_STORE": "chroma",
  "CHROMA_PATH": "/absolute/path/to/Sentinel/data/chroma",
  "CHROMA_COLLECTION": "sentinel"
}
```

---

### Amazon Bedrock Knowledge Bases (`bedrock`)

AWS-native knowledge connector using [Knowledge Bases for Amazon Bedrock](https://aws.amazon.com/bedrock/knowledge-bases/). Supports hybrid search (BM25 + semantic vector) and optional cross-encoder reranking.

**Install:** included in base install (uses `aioboto3`).

**How tags are stored:** documents are uploaded to S3 as `.txt` files alongside a `.metadata.json` file. Sentinel writes boolean fields for each tag:

```json
{
  "metadataAttributes": {
    "tag_finance": true,
    "tag_engineering": true
  }
}
```

Bedrock's retrieval filter then performs `tag_finance = true OR tag_engineering = true` as a native metadata filter.

**Create a Knowledge Base:** follow the [AWS QUICKSTART guide](QUICKSTART.md) or run:
```bash
python scripts/setup_aws.py
```

**Environment variables:**

| Variable | Required | Default | Description |
|---|---|---|---|
| `SENTINEL_KNOWLEDGE_STORE` | ✅ | — | Must be `bedrock` |
| `BEDROCK_KB_ID` | ✅ | — | Knowledge Base ID |
| `BEDROCK_S3_BUCKET` | ✅ | — | S3 bucket for document storage |
| `BEDROCK_S3_PREFIX` | — | `documents/` | S3 key prefix |
| `BEDROCK_DS_ID` | — | `""` | Data Source ID (enables KB sync after ingest) |
| `AWS_REGION` | — | `us-east-1` | AWS region |
| `AWS_PROFILE` | — | `default` | AWS credentials profile |
| `BEDROCK_SEARCH_TYPE` | — | `HYBRID` | `HYBRID` (BM25 + vector) or `SEMANTIC` |
| `BEDROCK_RERANKING` | — | `false` | Enable cross-encoder reranking |
| `BEDROCK_RERANK_MODEL_ARN` | — | amazon.rerank-v1:0 | Reranker model ARN |
| `BEDROCK_RERANK_OVERSAMPLE` | — | `3` | Candidate multiplier before reranking |

**MCP config snippet:**
```json
"env": {
  "SENTINEL_KNOWLEDGE_STORE": "bedrock",
  "BEDROCK_KB_ID": "your-kb-id",
  "BEDROCK_S3_BUCKET": "your-kb-bucket",
  "BEDROCK_DS_ID": "your-datasource-id",
  "AWS_REGION": "us-east-1",
  "AWS_PROFILE": "your-profile",
  "BEDROCK_SEARCH_TYPE": "HYBRID",
  "BEDROCK_RERANKING": "false"
}
```

---

## Supported Combinations

| Identity | Knowledge | Use Case |
|---|---|---|
| `sqlite` | `chroma` | Local development, CI, unit testing |
| `spicedb` | `chroma` | Local dev with relationship-based access control |
| `dynamodb` | `bedrock` | AWS production — explicit identity table |
| `iam` | `bedrock` | AWS production — zero-ops identity via IAM tags |
| `spicedb` | `bedrock` | AWS production with ReBAC identity |
| `iam` | `chroma` | Mixed: IAM identity, self-hosted knowledge |
| `sqlite` | `bedrock` | Mixed: simple identity, cloud knowledge |
| `dynamodb` | `chroma` | Mixed: cloud identity, self-hosted knowledge |

Any combination is supported — Sentinel's connector interfaces are fully orthogonal.

---

## Implementing a Custom Connector

Implement the abstract base class from [`sentinel_engine.base`](https://github.com/aashishravindran/sentinel-engine/blob/main/sentinel_engine/base.py):

```python
from sentinel_engine.base import IdentityConnector


class MyIdentityConnector(IdentityConnector):
    async def get_tags(self, user_id: str) -> set[str]:
        # Return the set of permission tags for this user.
        # Return an empty set if the user does not exist (fail-closed).
        ...
```

```python
from sentinel_engine.base import KnowledgeConnector


class MyKnowledgeConnector(KnowledgeConnector):
    async def search(self, query: str, tags: set[str], n_results: int = 5) -> list[dict]:
        # Return filtered results. Each dict must have: text, metadata, score.
        ...

    async def ingest(self, text: str, access_tags: list[str], doc_id: str, metadata: dict) -> None:
        # Persist the document with its access tags.
        ...
```

Wire your connector in by adding a branch to `sentinel_engine.factory` (or construct `SentinelEngine(identity, knowledge)` yourself and pass it to `sentinel.adapters.mcp.server.create_server`).
