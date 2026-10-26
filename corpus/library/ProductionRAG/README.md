# ProductionRAG — AI-Powered Resume Chat

A production-ready RAG (Retrieval-Augmented Generation) application that turns my resume into an interactive chat interface. Ask it anything about my experience, skills, and projects — and get accurate, context-grounded answers.

## What Makes This Different

Everyone builds RAG apps. This one is **about me** — a personal resume assistant powered by retrieval-augmented generation, built to production standards. It's both a portfolio piece and a practical demonstration of RAG done right.

## Architecture

```
                                    ┌─────────────────────────┐
Source PDFs ──> Ingestion Pipeline ──> ChromaDB Vector Store   │
                                    └─────────────────────────┘
                                                │
User Query ──> Query Analyzer (Embedding Router) ──> Metadata Filters
                        │                                  │
                        ├── BM25 Keyword Search ───────────┤
                        └── Vector Semantic Search ────────┘
                                        │
                                  RRF Fusion
                                        │
                              Cross-Encoder Rerank
                                        │
                                  Ollama LLM ──> Answer + Sources + Response Time
```

### Pre-Retrieval: Query Analysis

Before any retrieval happens, the query is analyzed to determine which document types and metadata filters to apply. This prevents irrelevant documents from flooding the results (e.g., research papers appearing for "What are my skills?").

**Embedding-based Prototype Vector Routing** (~10-60ms per query):
- Pre-computes average embedding vectors ("prototypes") for each document category (resume, projects, research) from representative exemplar sentences
- At query time, embeds the user's question and classifies it by cosine similarity against the prototypes
- Prototypes are computed once and cached — subsequent queries are just a single embedding + dot products
- Replaces the previous LLM-based classifier (ChatOllama call) that added 5-10 seconds of latency

**Keyword-based metadata extraction**:
- Resume section detection: matches query against section-specific keywords (Experience, Skills, Education, etc.)
- Project name detection: case-insensitive matching against known GitHub repository names
- These extracted fields become ChromaDB `where` filters for precise retrieval

### Data Ingestion
- **PDF Loading** — PyPDFLoader extracts text from source PDFs (GitHub project descriptions, resume, research papers)
- **Per-type Chunking** — Projects use 1000/200 chunks to keep descriptions intact; resume uses 800/200; research uses 1500/200
- **Rich Metadata Enrichment** — Each chunk is tagged with document type, source file, page, chunk index, plus source-specific fields:
  - **Projects**: project name, category, language, status, URL (mapped from page number)
  - **Resume**: section detection (Experience, Skills, Education, etc.) with forward-propagation through consecutive chunks
- **Hypothetical Questions (HyDE)** — For project documents, Ollama generates 3 hypothetical questions per chunk at ingestion time, prepended to content before embedding to improve query-document alignment
- **Vector Store** — Chunks are embedded using `all-MiniLM-L6-v2` (384 dims) and persisted in ChromaDB

### Search Methodology: Hybrid Retrieval

The retrieval pipeline combines keyword and semantic search for best-of-both-worlds results:

1. **BM25 Keyword Search** — Ranks all chunks by keyword relevance using BM25Okapi with stopword removal. Excels at exact term matches: company names ("Amazon"), technical acronyms ("CRC"), version numbers ("Python 3.10"). Candidate pool is pre-filtered by doc type from query analysis
2. **Vector Semantic Search** — ChromaDB cosine similarity over 384-dim embeddings with metadata `where` filters from query analysis. Excels at meaning-based matching: "DevOps automation" finds chunks about "CI/CD pipelines" even without keyword overlap
3. **Reciprocal Rank Fusion (RRF)** — Merges the top-10 results from both BM25 and vector search into a single ranked list. Documents appearing in both lists get boosted scores
4. **Cross-Encoder Reranking** — The fused candidates are re-scored by a cached cross-encoder model (`cross-encoder/ms-marco-MiniLM-L-6-v2`) that reads each (query, chunk) pair jointly for precise relevance scoring. The model is loaded once and reused across queries. Returns the final top-5 results

### Generation
- **Ollama (local LLM)** — Uses `llama3.2` running locally via Ollama for answer generation
- **Grounded Responses** — System prompt enforces that answers are based only on retrieved context, minimizing hallucination
- **Structured Output** — Returns the generated answer, source documents, and total response time in milliseconds

## Tech Stack

- **Python 3** — Core language
- **LangChain** — Document loading, text splitting, embeddings interface, retriever abstraction
- **ChromaDB** — Vector store with local file persistence
- **HuggingFace sentence-transformers** — Embeddings (all-MiniLM-L6-v2) and cross-encoder reranking (ms-marco-MiniLM-L-6-v2)
- **rank-bm25** — BM25Okapi keyword retrieval
- **NumPy** — Cosine similarity for prototype vector routing
- **Ollama + langchain-ollama** — Local LLM inference (llama3.2)
- **pypdf / fpdf2** — PDF parsing and generation
- **pytest** — Test suite (107 tests, all using fake embeddings and mocks — no external deps needed)

## Getting Started

```bash
# Clone the repo
git clone https://github.com/aashishravindran/ProductionRAG.git
cd ProductionRAG

# Set up virtual environment
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Run the ingestion pipeline (populates ChromaDB)
python -m ingestion.pipeline

# Ask a question (requires Ollama running locally with llama3.2)
python -m retrieval.rag_chain "What are your key skills?"
```

### Prerequisites
- Python 3.10+
- [Ollama](https://ollama.com/) installed with `llama3.2` model pulled (`ollama pull llama3.2`)

## Roadmap

- [x] Project scaffolding and dependency setup
- [x] Data sourcing (GitHub API to PDF, source validation)
- [x] Resume data ingestion pipeline with rich metadata
- [x] Vector store integration (ChromaDB)
- [x] Retrieval pipeline (hybrid: BM25 + vector search + RRF fusion)
- [x] Cross-encoder reranking (ms-marco-MiniLM-L-6-v2, cached)
- [x] Hypothetical question enrichment (HyDE) for project docs
- [x] LLM-powered answer generation (Ollama)
- [x] Embedding-based query analyzer (prototype vector routing)
- [x] Per-query response time tracking
- [ ] Chat UI
- [ ] Deployment and observability
- [ ] Evaluation and testing suite

## License

MIT
