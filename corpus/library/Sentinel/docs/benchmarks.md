# Benchmarks

Three questions, three answers. Every number here comes from a script in
`tests/` that you can rerun.

| Question | Result |
|---|---|
| Does anything leak? | **0 leaks in 1,728 adversarial attempts** across all four entry points |
| What does Sentinel cost per call? | **~0.17 ms p50** for the full Gateway path, excluding network and store round trips |
| Why push the filter into the query? | **Recall@5 stays at 1.00**; post-filtering falls to 0.10 at 10 departments and 0.02 at 50 |

## 1. Red-team leak rate

`uv run pytest -m redteam` (runs in CI on every PR; the build fails on any leak)

Every combination of:

- **4 entry points**: MCP over stdio, MCP over HTTP, AgentCore Gateway with the Lambda
  target, AgentCore Gateway with a Managed KB
- **6 personas**: three employees, an intern (public only, inherited through a team), a user
  with no access, and an admin (who holds no document access)
- **6 adversarial queries**: prompt injection, fake `user_id` claims, filter syntax, XML
  smuggling
- **6 argument injections**: `user_id`, `userContext`, a raw `filter`, a full
  `retrievalConfiguration`, a forged principal envelope, or none
- **2 knowledge bases**: one that honors filters, and one that **ignores them entirely**

| Attempts | Leaks | Leak rate |
|---:|---:|---:|
| 1,728 | 0 | 0.0 |

A leak is any returned document whose tags the persona does not hold. The report is written
to `build/redteam.json` and uploaded as a CI artifact.

A separate token matrix sends 11 kinds of bad tokens to the three networked entry points:
expired, not yet valid, wrong issuer or audience, a foreign signing key, `alg: none`, no
expiry, no subject, a wildcard subject, an email subject, and garbage. All 33 are denied
before the knowledge base is called.

> The token matrix found one real bug while it was being written: FastMCP's `JWTVerifier`
> does not check `nbf`, so a not-yet-valid token was accepted over MCP HTTP. Sentinel's
> shared claim checks now enforce it for every adapter.

### Defense in depth, measured

With the engine's post-filter deliberately disabled and a knowledge base that ignores
filters, the two MCP paths leak, as expected, and the two Gateway paths still return
nothing unauthorized. The response interceptor re-checks every chunk on its own.

## 2. Latency Sentinel adds

`uv run python -m tests.load.bench_layers --n 5000` on an Apple M5 Max, Python 3.14.

The identity store and knowledge base are in-memory fakes, so these numbers are Sentinel's
own work only: RS256 verification, scope resolution, filter building, argument rewriting,
envelope sealing and the post-filter.

**Engine** (what both MCP transports call)

| Layer | p50 (ms) | p99 (ms) |
|---|---:|---:|
| identity lookup | 0.000 | 0.001 |
| knowledge base call (fake) | 0.009 | 0.028 |
| post-filter | 0.001 | 0.002 |
| **total** | **0.012** | **0.041** |

**AgentCore Gateway path** (request interceptor, Lambda target, response interceptor)

| Layer | p50 (ms) | p99 (ms) |
|---|---:|---:|
| request interceptor | 0.070 | 0.114 |
| Lambda target | 0.020 | 0.038 |
| response interceptor | 0.072 | 0.129 |
| **total** | **0.168** | **0.279** |

**Not measured here:** network hops, Lambda invocation overhead and cold starts, DynamoDB
`GetItem` (two per Gateway call: one in each interceptor), and Bedrock retrieval. Those
dominate real latency and have not been measured on a live deployment yet. Enable
provisioned concurrency on the interceptors (`provisionedConcurrency` on the construct)
to keep cold starts off the auth path.

## 3. Recall: filter in the query vs. filter afterwards

`uv run python -m tests.load.recall --departments N --per-topic 5 --k 5`

A synthetic organization where every department writes about the same five topics. A user
asks about a topic ("what is the budget forecast?") and may read only their own
department's documents. ChromaDB with `all-MiniLM-L6-v2`.

| Departments | Corpus | Filter in the query (Sentinel) | Retrieve top-k, then filter |
|---:|---:|---:|---:|
| 2 | 50 | **1.00** | 0.50 |
| 10 | 250 | **1.00** | 0.10 |
| 50 | 1,250 | **1.00** | 0.02 |

Post-filtering fetches the global top-k, which mostly belongs to other people, then throws
it away. The larger the organization, the less any one user can see, and the worse it
gets: recall falls to roughly 1/N. Pushing the filter into the vector query searches only
what the user may read.
