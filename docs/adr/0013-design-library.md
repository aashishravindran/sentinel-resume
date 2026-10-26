# 0013. A public design library, so "why" questions are grounded

## Context

Recruiters and hiring managers ask why a project was built a certain way, not only what it does. The
resume and a one-page projects summary can't answer that; the reasoning lives in each project's ADRs,
flows and architecture notes, spread across several GitHub repos.

## Decision

- Ingest a **design library** with tag `public`:
  - this repo's README, `FLOW.md`, `DECISIONS.md` and `docs/adr/*`, read in place at ingest, so they are
    never stale;
  - READMEs, architecture notes, threat models, benchmarks and ADRs from Aashish's other **public**
    repos, copied into `corpus/library/` by `scripts/sync_library.py` (which refuses private repos) and
    committed.
- Prefix every chunk with the project and document title (`Sentinel ADR 0002: Every failure denies >
  Decision`) instead of the document's own heading. Sentinel and this repo both have an "ADR 0001";
  without the project name the embedding can't tell them apart.
- `scripts/ingest_corpus.py` prunes vectors of documents that left the catalog or library.
- The system prompt tells the model to answer "why" questions from ADRs and decision records, name the
  ADR, and not state consequences the documents don't.
- `/api/catalog` lists the library (titles and GitHub links). Everyone may read it, so listing it
  reveals nothing; chat sources link to GitHub.

## Consequences

- A test fails if any library document contains a dollar figure, SSN-like number or reference name
  from a restricted document: the library is public, so it must never quote one.
- Copies go stale until someone re-runs the sync; that is deliberate, so every change to what
  recruiters can read is reviewed in a pull request, and deploys never depend on GitHub.
- About 460 chunks; re-embedding them on each deploy costs well under a cent with Titan.
- Retrieval now competes across many documents. Questions about "this site" get the project name added
  to the search query, and `n_results` went from 6 to 8.
