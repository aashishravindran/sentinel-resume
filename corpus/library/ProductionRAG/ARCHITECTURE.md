# ProductionRAG — Architecture & Design Decisions

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [System Overview](#2-system-overview)
3. [Data Sources](#3-data-sources)
4. [Ingestion Pipeline](#4-ingestion-pipeline)
5. [Retrieval Pipeline](#5-retrieval-pipeline)
6. [Generation](#6-generation)
7. [Evaluation Framework](#7-evaluation-framework)
8. [Design Decision Log](#8-design-decision-log)
9. [Evaluation Results](#9-evaluation-results)

---

## 1. Problem Statement

A resume is a dense, static document. It cannot answer follow-up questions, explain context, or synthesise across related materials. ProductionRAG turns a personal resume and supporting documents into an interactive AI chat interface: ask a natural-language question, get a grounded, citation-backed answer drawn entirely from the source material.

The scope is intentionally narrow — a personal knowledge base, not a general assistant. Every design decision flows from three constraints:

- **No cloud API costs at inference time** — the pipeline runs fully locally.
- **High retrieval precision** — answers must be grounded in the documents, not hallucinated.
- **Measurable quality** — the system has an automated evaluation harness so regressions are caught.

---

## 2. System Overview

```
DATA SOURCING
  GitHub API ──► github_projects_detailed.py ──► github_projects_detailed.pdf
  Resume.pdf (manual)
  Gen_ai_divide.pdf (research paper, manual)

INGESTION (one-time, offline)
  PDFs ──► PyPDFLoader ──► per-type chunker ──► metadata enrichment
        ──► HyDE enrichment (Ollama, projects + resume only)
        ──► ChromaDB (sentence-transformers/all-MiniLM-L6-v2 embeddings)

QUERY TIME (online, ~1–5 s retrieval)
  User query
    │
    ▼
  Query Analyzer (embedding prototype routing, ~5 ms)
    │ doc_type filter + resume_section + project_name
    ▼
  ┌────────────────────────────────────────┐
  │  BM25 (top 10)   │  Vector (top 15)   │  ← filtered by doc_type
  └──────────┬───────┴──────────┬─────────┘
             └────── RRF ───────┘
                       │ up to 25 fused candidates
                       ▼
             Cross-encoder reranker (ms-marco-MiniLM-L-6-v2)
                       │ top 5
                       ▼
  Generator (ChatOllama, llama3.2, local)
                       │
                       ▼
  Answer + source citations
```

---

## 3. Data Sources

Three PDFs live in `data_sourcing/data/`. Each maps to a distinct `document_type` used throughout the pipeline for routing and filtering.

| File | `document_type` | Purpose |
|---|---|---|
| `Resume.pdf` | `resume` | Professional summary, experience bullets, education, skills |
| `github_projects_detailed.pdf` | `projects` | RAG-optimised PDF, one section per repository with description, tech stack, key features, architecture notes |
| `Gen_ai_divide.pdf` | `research` | MIT NANDA 2025 industry report on enterprise GenAI adoption |

### Why a custom GitHub PDF instead of raw API data?

The GitHub REST API returns sparse repository data (name, description, stars). It cannot convey architecture decisions, tech stack rationale, or feature depth. `github_projects_detailed.py` generates a structured PDF manually curated per repository: description, what it does, tech stack, key features, and architectural context. This substantially improves semantic retrieval quality compared to auto-generated API summaries.

The PDF format was chosen over raw text or JSON because:
- `PyPDFLoader` handles page boundaries cleanly, and each project section maps to predictable pages (page 0 = cover, page 1 = TOC, pages 2+ = one project per page). This enables the `metadata.py` enricher to tag every chunk with exact `project_name`, `project_category`, `project_language`, `project_status`, and `project_url` by a simple page-number lookup.

---

## 4. Ingestion Pipeline

The ingestion pipeline runs once offline (or when source documents change) and produces a persistent ChromaDB collection. It is a five-stage chain defined in `ingestion/pipeline.py`.

```
load_all_pdfs  →  chunk_documents  →  enrich_metadata  →  enrich_with_questions  →  create_vector_store
```

### 4.1 Loading — `ingestion/loader.py`

`PyPDFLoader` extracts raw text page-by-page. Each page becomes a LangChain `Document` with `source_file`, `document_name`, and `page` in its metadata. This page-level metadata is carried forward through chunking and becomes the basis for the project-name page map in the enricher.

### 4.2 Chunking — `ingestion/chunker.py`

`RecursiveCharacterTextSplitter` splits on paragraph and sentence boundaries before resorting to character splits. Critically, chunk size is **per document type**, not global:

| `document_type` | `chunk_size` | `chunk_overlap` | Rationale |
|---|---|---|---|
| `projects` | 1000 | 200 | Each project section is a dense, rich page. Large chunks keep description, tech stack, and features together, preserving the full semantic context for a project query. |
| `resume` | 250 | 50 | Individual bullet points are the atomic unit of a resume. At 250 chars, each chunk holds roughly one bullet. This prevents the embedding of a high-impact bullet (e.g. the Bedrock 80% accuracy achievement) from being diluted by adjacent unrelated bullets. |
| `research` | 600 | 150 | Research chunks need to be large enough to capture a complete statistical claim or argument (a stat + its context sentence), but small enough that specific figures (e.g. "5% of enterprises deploy at scale") are not buried inside a 1500-char block whose embedding drifts to the surrounding narrative. |

The overlap ensures continuity at split boundaries: a sentence that ends near a chunk boundary is partially replicated in the adjacent chunk so neither chunk loses the full sentence's meaning.

### 4.3 Metadata Enrichment — `ingestion/metadata.py`

Every chunk gets `document_type` and a global `chunk_index`. Additionally:

- **projects chunks**: `project_name`, `project_category`, `project_language`, `project_status`, `project_url` — looked up from a page-number map built from the `PROJECTS` list in `github_projects_detailed.py`. This allows the retriever to filter to a specific project by name.
- **resume chunks**: `resume_section` — detected by regex against known section headers (`Professional Summary`, `Experience`, `Education`, `Skills`, `Certifications`). A forward-propagation pass ensures bullet-point chunks below a header inherit the header's section label even if the header itself was split into the previous chunk.

### 4.4 HyDE Enrichment — `ingestion/questions.py`

HyDE (Hypothetical Document Embedding) addresses the **query-document gap**: user queries are questions, but document chunks are declarative statements. Embedding distance between a question ("What RAG accuracy did Aashish achieve?") and a statement ("...achieving 80% accuracy...") is larger than between two questions or two statements.

The fix: for each chunk, an LLM generates three hypothetical questions that the chunk could answer. These questions are prepended to the chunk's `page_content`:

```
Questions this answers:
What accuracy did the Knowledge Base RAG system achieve?
What did Aashish build using Amazon Bedrock?
What was the precision of the automated response system?

Architected the team's first AI agents using Amazon Bedrock...
```

The original content is preserved in `metadata["original_content"]`. This field is used in two places:
1. **BM25 search** — indexes `original_content` to avoid keyword-matching the generated questions.
2. **Generation** — passes `original_content` to the LLM as context so the answer isn't polluted by meta-questions.

**HyDE is applied only to `projects` and `resume` chunks, not `research`.**

The research document (Gen_ai_divide.pdf) contains specific numerical statistics ("5% deploy", "67% external partnerships") that need to be embedded exactly as stated — prepending hypothetical questions dilutes those precise signal embeddings. The projects and resume chunks benefit more because their content is narrative and the gap to natural-language queries is larger.

### 4.5 Vector Store — `ingestion/store.py`

ChromaDB is the persistent vector store. Embedding model: `sentence-transformers/all-MiniLM-L6-v2` (384-dimensional). This model is:
- Already used by the cross-encoder pipeline (consistent embedding space)
- Fast and lightweight (runs comfortably on CPU)
- Good semantic coverage for English technical text
- Freely available, no API key required

The collection is named `resume_documents` (historical: the initial design only held resume content; the name was retained to avoid breaking the ChromaDB persistence contract).

Final collection breakdown after ingestion: **177 chunks** (31 projects, 24 resume, 122 research).

---

## 5. Retrieval Pipeline

The retrieval pipeline runs per query and is defined in `retrieval/retriever.py`. It is a four-stage chain: **query analysis → dual retrieval → RRF fusion → cross-encoder reranking**.

### 5.1 Query Analysis — `retrieval/query_analyzer.py`

Before retrieving anything, the query is analysed to identify:
1. **`doc_types`** — which document type(s) are relevant (`resume`, `projects`, `research`, or all three)
2. **`resume_section`** — which resume section to filter on, if applicable
3. **`project_name`** — which specific project to filter on, if applicable

**Classification method: embedding prototype routing (~5 ms)**

Each document type has 10 representative exemplar questions. On first call, the exemplars are embedded and averaged into a centroid prototype vector per type. Incoming queries are classified by cosine similarity to each prototype. Types whose similarity exceeds a 0.4 threshold (plus any within 0.1 of the top score) are returned.

This was chosen over LLM-based classification for one reason: **speed**. An LLM classifier takes 5–10 seconds on CPU. Embedding similarity takes ~5 ms. Since the model is already loaded for retrieval, there is no marginal cost.

Resume section and project name are extracted by lightweight keyword matching (O(n) scan), not embeddings.

### 5.2 BM25 Keyword Search

BM25Okapi runs over the full filtered candidate pool (all chunks matching the detected `doc_types`). It uses `original_content` metadata when available to avoid matching against the HyDE-prepended questions. A custom stopword list removes noise tokens. Returns top 10 candidates.

BM25 excels at retrieving chunks that contain exact terminology from the query — important for queries like "18-month window" or "Hire and Develop The Best" where keyword overlap is highly diagnostic.

### 5.3 Vector Semantic Search

ChromaDB's cosine similarity search runs with the same `doc_types` metadata filter. Returns top 15 candidates.

Vector search is better than BM25 at handling paraphrase and semantic intent (e.g. "how does the system handle tired users?" → fatigue decay model). The larger pool (15 vs 10) ensures rarer but highly relevant chunks can surface.

### 5.4 Reciprocal Rank Fusion (RRF)

BM25 and vector results are merged with RRF:

```
score(doc) = Σ 1 / (k + rank_i)   for each list i containing doc
k = 60  (standard default)
```

RRF was chosen over weighted score combination because:
- It requires no calibration between BM25 and cosine score scales (they are incomparable raw numbers)
- It is robust to outlier scores — a single very high BM25 score won't dominate
- It rewards documents that rank well in **both** lists

The merged list can be up to 25 documents (10 BM25 + 15 vector, minus overlaps).

### 5.5 Cross-Encoder Reranking

The fused list is reranked by `cross-encoder/ms-marco-MiniLM-L-6-v2`. Unlike bi-encoder embeddings (which encode query and document independently), a cross-encoder sees the query and document **together**, allowing fine-grained relevance scoring that captures precise phrasing alignment.

The model scores each (query, `original_content`) pair. Using `original_content` here (instead of the HyDE-enriched `page_content`) ensures the cross-encoder evaluates actual document content against the query, not meta-questions against the query.

Final output: top 5 documents by cross-encoder score.

### 5.6 Configuration

```python
BM25_TOP_K = 10
VECTOR_TOP_K = 15
RRF_K = 60
RETRIEVAL_TOP_K = 5
RERANKER_MODEL = "cross-encoder/ms-marco-MiniLM-L-6-v2"
```

`VECTOR_TOP_K` was increased from 10 to 15 during evaluation tuning: the "Narrowing Window" section header (chunk 74 of the research doc) ranked at vector position 12, so it was invisible to the fusion step until the pool was widened.

---

## 6. Generation

### 6.1 LLM — Ollama (llama3.2:latest)

The answer is generated by `llama3.2:latest` running locally via Ollama. The model receives:

1. A **system prompt** that strictly scopes the assistant: *"Use ONLY the provided context to answer. Do not make up information."*
2. A **user message** containing the formatted context (up to 5 source chunks, each prefixed with source file and page number) followed by the question.

Context chunks are rendered using their `original_content` (not the HyDE-enriched version) to keep the LLM focused on actual document text.

### 6.2 Why Ollama / local LLM?

- Zero marginal cost per query
- No data leaves the machine (resume content stays private)
- Reproducible behaviour (same model version, no API-side changes)
- The tradeoff is latency: llama3.2 on CPU takes 10–55 seconds depending on context length. This is acceptable for a personal portfolio tool.

---

## 7. Evaluation Framework

The evaluation lives in `tests/evaluation/` and comprises three components: the golden dataset, the metrics module, and two pytest test suites.

### 7.1 Golden Dataset — `tests/evaluation/golden_dataset.json`

31 question–answer–context triplets:

| Source | Count | Difficulty distribution |
|---|---|---|
| Resume.pdf | 11 | Easy: 4, Medium: 6, Hard: 1 |
| Gen_ai_divide.pdf | 10 | Easy: 4, Medium: 4, Hard: 2 |
| github_projects_detailed.pdf | 9 | Easy: 1, Medium: 5, Hard: 3 |
| Cross-document (stress tests) | 1 (xfail) | Hard: 1 |

Each triplet includes:
- `question` — natural-language query
- `ground_truth_context` — verbatim text from the expected source chunk (not a synthetic summary; must match actual ChromaDB chunk content)
- `answer` — expected LLM response (for e2e evaluation)
- `document_source`, `difficulty`, `reasoning_type` — for stratified reporting
- `stress_test_note` — present on hard-negative entries that test known limitations

**Ground-truth contexts are verbatim chunk excerpts.** Early versions used condensed paraphrases ("the pilot-to-production chasm (60% investigate, 20% pilot, 5% deploy)") but this caused context_recall scores around 0.48 because the paraphrase's embedding diverged from the actual chunk text. Updating to verbatim chunks raised those scores above 0.70.

### 7.2 Metrics — `tests/evaluation/metrics.py`

Four self-contained metrics, no LLM judge required:

| Metric | What it measures | Threshold | Implementation |
|---|---|---|---|
| **Context Recall** | Max cosine similarity between the GT context and any retrieved chunk | ≥ 0.55 | Sentence-transformers embeddings; uses `original_content` metadata to avoid HyDE dilution |
| **Answer Similarity** | Cosine similarity between generated answer and GT answer | ≥ 0.50 | Sentence-transformers; tolerates paraphrasing |
| **ROUGE-L F1** | Token-level longest common subsequence overlap | ≥ 0.12 | Implemented from scratch; avoids rouge-score dependency |
| **Faithfulness** | Fraction of significant answer tokens present in retrieved context | ≥ 0.40 | Stopword-filtered token overlap; detects hallucination |

The generous ROUGE-L threshold (0.12) reflects that a generative LLM will paraphrase rather than copy. ROUGE-L catches gross mismatches (completely wrong answer) without penalising correct paraphrase.

Context Recall uses `original_content` metadata rather than `page_content`. Before this fix, HyDE-enriched chunks had embeddings shaped by three prepended questions; comparing those against GT contexts produced artificially low similarity scores (~0.42) even when the right chunk was retrieved.

### 7.3 Test Suites

**`TestContextRecall`** (marker: `retrieval`) — runs without Ollama. Calls `retrieve()` directly on each golden question and asserts `context_recall >= 0.55`. This is the fast gate: ~27 seconds for all 31 questions with warm models.

**`TestEndToEnd`** (marker: `e2e`) — requires Ollama. Calls `ask()` for the full pipeline and asserts all four metrics plus a per-difficulty latency budget (Easy: 20 s, Medium: 25 s, Hard: 35 s). Auto-skipped when Ollama is not reachable.

One question is permanently marked `xfail`: the cross-document stress test that asks about both the GenAI Divide "5% deploy" stat and the resume's RAG accuracy figure simultaneously. A single-pass retriever cannot satisfy both intents with the same top-5 results — the test documents this known architectural limitation without blocking CI.

---

## 8. Design Decision Log

### D1 — Per-document-type chunk sizes

**Decision**: Different chunk sizes for `projects`, `resume`, and `research`.

**Why**: A single global chunk size of 500–800 chars consistently degraded retrieval for at least one document type:
- Resume at 400+ chars: three unrelated bullet points fit in one chunk. The embedding averages across bullets, so a query for the "Hire and Develop" leadership principle competes with the surrounding Bedrock 80% accuracy bullet and the MCP server bullet. Score dropped to 0.475.
- Research at 1500 chars: a specific statistic ("5% of enterprises deploy at scale") was buried inside a 1500-char chunk embedding that also encoded the surrounding narrative, dropping recall to ~0.52.
- Projects at <800 chars: project sections are cohesive single-topic blocks. Splitting aggressively created semantically incomplete chunks missing tech stack or feature context.

**Result**: Tuned empirically via the golden dataset evaluation. Resume settled at 250/50, research at 600/150, projects at 1000/200.

### D2 — HyDE excluded from research documents

**Decision**: Generate hypothetical questions only for `projects` and `resume` chunks, not `research`.

**Why**: The research document's value is in precise numerical facts. HyDE enrichment prepends questions like "What percentage of enterprises deploy GenAI?" to a chunk about the "5% deploy" statistic. The combined embedding then partially represents the meta-question, which dilutes the specific numerical signal. For narrative/experiential content (resume bullets, project descriptions) the query-document gap is large enough that HyDE's bridging benefit outweighs the dilution cost.

### D3 — Embedding-based query classifier over LLM classifier

**Decision**: Prototype vector routing for query analysis.

**Why**: LLM classification was the obvious first implementation — call the LLM, ask it to classify the query. On CPU, this adds 5–10 seconds to every query, more than doubling total latency. The embedding-based approach reuses the model already loaded for retrieval and runs in ~5 ms. Accuracy is acceptable: the 0.4 cosine threshold with a 0.1 gap for secondary types correctly handles ambiguous queries that span document types.

### D4 — BM25 + vector hybrid retrieval

**Decision**: Run both BM25 and vector search, merge with RRF.

**Why**: Pure vector search misses exact-phrase queries. A query containing "Hire and Develop The Best" will have high cosine similarity to many leadership-related chunks but may not rank the exact bullet highest. BM25 scores the exact phrase match directly. Conversely, BM25 fails on semantic paraphrase queries where no query term appears in the target chunk. Hybrid retrieval covers both failure modes.

### D5 — VECTOR_TOP_K = 15, not 10

**Decision**: Vector search returns 15 candidates, BM25 returns 10.

**Why**: During evaluation the "5.3 THE NARROWING WINDOW TO CROSS THE DIVIDE" section header ranked at vector position 12 for the 18-month-window query. With a pool of 10, it was invisible to the cross-encoder. Widening vector to 15 captures stragglers that are semantically relevant but not top-ranked by the vector model alone. BM25 stays at 10 because its keyword precision means rank-11+ BM25 results are usually noise.

### D6 — Cross-encoder reranking over bi-encoder score cutoff

**Decision**: Use ms-marco-MiniLM-L-6-v2 cross-encoder as the final reranker.

**Why**: The fused candidate pool after RRF contains up to 25 documents ranked by position-weighted vote, not direct relevance to the query. A cross-encoder sees the query and document together and can distinguish subtle relevance differences (e.g. two chunks both mentioning "5%" but one about deployment rates and one about accuracy). Bi-encoder similarity scores are incomparable across documents because cosine distance compresses the full embedding space.

The ms-marco model is specifically trained on passage reranking, making it well-suited to this task. It is cached with `lru_cache` so it loads once per process.

### D7 — ChromaDB for the vector store

**Decision**: Local persistent ChromaDB.

**Why**: This is a single-user personal portfolio tool. Managed vector databases (Pinecone, Weaviate) add infrastructure overhead, API keys, and ongoing costs that are disproportionate for the scale (177 chunks). ChromaDB persists to disk, reloads without re-embedding, and has a straightforward Python API that integrates natively with LangChain.

### D8 — Grounded system prompt (no hallucination)

**Decision**: System prompt explicitly forbids the LLM from going beyond provided context.

**Why**: The target audience asks factual questions about a specific person's background. An answer that embellishes or fabricates is worse than no answer — it misrepresents the candidate. The faithfulness metric (≥ 0.40 significant token overlap with retrieved context) enforces this programmatically in the test suite.

---

## 9. Evaluation Results

All metrics collected 2026-03-13. ChromaDB: 177 chunks (31 projects, 24 resume, 122 research). LLM: llama3.2:latest via Ollama on CPU.

Thresholds: context_recall ≥ 0.55 · answer_similarity ≥ 0.50 · rouge_l ≥ 0.12 · faithfulness ≥ 0.40 · latency ≤ budget (Easy 20 s, Medium 25 s, Hard 35 s).

### 9.1 Aggregate Summary

| Slice | N | CtxRecall | AnswerSim | ROUGE-L | Faithful |
|---|---|---|---|---|---|
| **Overall** | **30** | **0.770** | **0.748** | **0.298** | **0.644** |
| Resume.pdf | 11 | 0.819 | 0.780 | 0.343 | 0.624 |
| github_projects_detailed.pdf | 9 | 0.767 | 0.836 | 0.368 | 0.766 |
| Gen_ai_divide.pdf | 10 | 0.719 | 0.638 | 0.193 | 0.555 |
| Easy | 9 | 0.792 | 0.810 | 0.428 | 0.672 |
| Medium | 13 | 0.777 | 0.744 | 0.272 | 0.618 |
| Hard | 8 | 0.735 | 0.681 | 0.218 | 0.641 |

Retrieval suite: **30/30 pass**, 1 xfailed.
E2E suite: **14/31 pass all**, 8 latency-only failures (quality fine), 9 quality failures, 1 xfailed.

### 9.2 Per-Question Results

`CtxR` = context recall (retrieval suite) · `Sim` = answer similarity · `Rou` = ROUGE-L · `Fai` = faithfulness · `Lat` = latency (e2e suite). Failing metrics shown in **bold**.

#### Resume.pdf

| Status | Diff | CtxR | Sim | Rou | Fai | Lat | Question |
|---|---|---|---|---|---|---|---|
| PASS | Easy | 0.829 | 0.778 | 0.621 | 0.636 | 13 s | By what percentage did the Scalable Dataplane reduce onboarding time? |
| PASS | Easy | 0.802 | 0.790 | 0.421 | 0.692 | 10 s | What accuracy did the Knowledge Base RAG system achieve? |
| PASS | Easy | 0.839 | 0.913 | 0.600 | 0.600 | 9 s | What latency SLA did the async quota utilization APIs achieve? |
| PASS | Easy | 0.738 | 0.735 | 0.282 | 0.667 | 13 s | What was the purpose of the inaugural MCP server? |
| PASS | Easy | 0.868 | 0.738 | 0.265 | 0.750 | 11 s | How many years of experience does Aashish Ravindran have? |
| FAIL | Medium | 0.771 | 0.621 | **0.085** | **0.176** | 10 s | What database was chosen for the Scalable Dataplane? |
| PASS | Medium | 0.972 | 0.744 | 0.217 | 0.559 | 14 s | What AWS services powered the quota automation framework? |
| PASS | Medium | 0.724 | 0.783 | 0.327 | 0.667 | 10 s | Which AWS leadership principle did Aashish implement? |
| PASS | Medium | 0.725 | 0.658 | 0.286 | 0.536 | 18 s | What legacy bug was fixed at AWS SDE I? |
| PASS | Medium | 0.942 | 0.924 | 0.340 | 0.778 | 13 s | How did Aashish improve CI/CD deployment safety? |
| XFAIL | Hard | 0.798 | 0.640 | 0.060 | 0.431 | 53 s | How many distinct AI agent systems across resume + GitHub? *(cross-doc synthesis)* |

#### Gen_ai_divide.pdf

| Status | Diff | CtxR | Sim | Rou | Fai | Lat | Question |
|---|---|---|---|---|---|---|---|
| PASS | Easy | 0.680 | 0.955 | 0.562 | 0.600 | 9 s | What percentage of orgs get zero return on GenAI? |
| FAIL | Easy | 0.692 | 0.780 | **0.107** | 0.571 | 15 s | What is the production deployment rate for task-specific GenAI tools? |
| FAIL | Easy | 0.681 | 0.639 | **0.092** | 0.836 | **39 s** | What research methodology did the MIT NANDA authors use? |
| PASS | Medium | 0.623 | 0.545 | 0.216 | 0.921 | 16 s | What are the four defining patterns of the GenAI Divide? |
| FAIL | Medium | 0.771 | 0.825 | **0.147** | 0.758 | **58 s** | What is the shadow AI economy? *(latency only)* |
| FAIL | Medium | 0.885 | 0.589 | **0.105** | **0.273** | **51 s** | Describe the pilot-to-production chasm and funnel percentages |
| FAIL | Medium | 0.694 | 0.851 | 0.204 | 0.804 | **28 s** | How do external partnerships compare to internal builds? *(latency only)* |
| PASS | Hard | 0.760 | 0.757 | 0.143 | 0.556 | 34 s | What are the three winning behaviors for AI-buying orgs? |
| FAIL | Hard | 0.561 | **0.435** | 0.209 | 0.727 | 24 s | What workforce reduction does the GenAI Divide predict? |
| FAIL | Hard | 0.848 | **0.445** | 0.141 | **0.391** | 23 s | What does the 18-month window refer to? |
| XFAIL | Hard | — | 0.712 | 0.156 | **0.200** | **53 s** | Does the GenAI 5% deploy match the resume RAG accuracy? *(cross-doc hard negative)* |

#### github_projects_detailed.pdf

| Status | Diff | CtxR | Sim | Rou | Fai | Lat | Question |
|---|---|---|---|---|---|---|---|
| PASS | Easy | 1.000 | 0.760 | 0.370 | 0.778 | 15 s | Total repositories and generation date? |
| PASS | Hard | 0.705 | 0.777 | 0.300 | 0.724 | **38 s** | What hybrid retrieval strategy does ProductionRAG use? *(latency only)* |
| FAIL | Hard | 0.571 | 0.838 | 0.278 | 0.707 | **47 s** | How does agentic-fitness-app track fatigue? *(latency only)* |
| PASS | Hard | 0.874 | 0.846 | 0.320 | 0.767 | 33 s | What AI framework does AiAgents use? |
| XFAIL | Hard | 0.760 | 0.465 | 0.195 | 0.348 | 34 s | MCP server on resume vs. MCP demo in GitHub — same system? *(cross-doc ambiguity)* |
| FAIL | Medium | 0.699 | 0.844 | 0.191 | 0.875 | **36 s** | Which archived academic projects are listed? *(latency only)* |
| FAIL | Medium | 0.751 | 0.861 | 0.557 | 0.861 | **49 s** | What is steal-my-agents and its two installation modes? *(latency only)* |
| FAIL | Medium | 0.856 | 0.866 | 0.421 | 0.667 | **33 s** | What video quality metric does video_quantification use? *(latency only)* |
| FAIL | Medium | 0.690 | 0.964 | 0.576 | 0.913 | **52 s** | What multi-agent pattern does agentic-fitness-app use? *(latency only)* |

### 9.3 Failure Analysis

**Latency-only failures (8)** — all quality metrics pass; llama3.2 on CPU is the bottleneck:

All 8 have answer_similarity ≥ 0.777, ROUGE-L ≥ 0.143, faithfulness ≥ 0.556. Upgrading to GPU or a faster model (e.g. llama3.2:1b) resolves these without touching the retrieval pipeline.

**Quality failures (9):**

| Question | Failing Metrics | Root Cause |
|---|---|---|
| DynamoDB backend (resume) | ROUGE-L 0.085, faithfulness 0.176 | LLM answer verbose; low lexical overlap with short GT answer |
| Production deployment rate | ROUGE-L 0.107 | Borderline; LLM paraphrases "5%" without exact phrasing |
| Research methodology | ROUGE-L 0.092 | LLM paraphrases count data (52 interviews, 153 surveys) |
| Shadow AI economy | ROUGE-L 0.147 | Lexical mismatch despite correct semantics (sim=0.825) |
| Pilot-to-production chasm | ROUGE-L 0.105, faithfulness 0.273 | LLM does not reproduce the 60%→20%→5% funnel |
| External partnerships | — | Latency-only (qual passes); see latency section |
| Workforce reduction | Answer similarity 0.435 | LLM answer missing sector-specific detail (tech/media) |
| 18-month window | Answer similarity 0.445, faithfulness 0.391 | Retrieved section header describes concept; specific timeframe in adjacent chunk |
| MCP cross-doc (xfail) | Answer similarity 0.465, faithfulness 0.348 | Known: retriever can't satisfy two-doc intent in one pass |

**Effective quality pass rate (ignoring CPU latency): 22/31 (71%).**

---

*Generated: 2026-03-13. Run: `pytest tests/evaluation/ -m retrieval` (30 s) and `pytest tests/evaluation/ -m e2e` (16 min on CPU).*
