# Fitness Agent RAG Specification (Local MVP)

## 1. Project Objective

Build a local-first, agentic fitness platform that uses **Retrieval-Augmented Generation (RAG)** to provide coaching grounded in specific "Creator" philosophies. The system must handle state (memory) to ensure daily workouts pivot based on fatigue and historical logs.

## 2. Local Tech Stack

- **Orchestration:** LangGraph (State management and HITL breakpoints).
- **Vector Database:** ChromaDB (Local persistent storage).
- **Embeddings:** Ollama (running `mxbai-embed-large` locally).
- **Logic:** PydanticAI (Type-safe, structured coaching outputs).
- **Persistence:** `SqliteSaver` (Local checkpointing of user sessions).

## 3. Recommended File Structure

```text
/fitness-platform
├── .env                  # API Keys (OpenAI/Anthropic)
├── main.py               # Graph execution script
├── state.py              # Shared FitnessState definition
├── ingest.py             # RAG ingestion script
├── creator_db/           # ChromaDB local persistence folder
├── creators/             # Folder containing .md files for each creator
│   ├── coach_iron.md
│   └── yoga_master.md
└── agents/
    ├── retriever.py      # Node for ChromaDB searching
    ├── trainer.py        # Node for workout generation
    └── nutritionist.py   # Node for calorie calculation
```

## 4. Key Components to Implement

### A. The State (`state.py`)

The state must track muscle fatigue and the information retrieved from the RAG database.

```python
from typing import List, Dict, Optional, TypedDict


class FitnessState(TypedDict):
    user_id: str
    selected_creator: str
    fatigue_scores: Dict[str, float]  # e.g., {"legs": 0.8, "push": 0.1}
    retrieved_rules: List[str]  # Context from RAG
    current_workout: Optional[str]
    is_approved: bool  # HITL status
```

### B. Ingestion Logic (`ingest.py`)

Implement a script that:

1. Iterates through the `/creators` folder.
2. Chunks documents using `RecursiveCharacterTextSplitter`.
3. Adds chunks to ChromaDB with **Metadata** for `creator_name`.

### C. The Agentic Workflow (`graph.py`)

The graph should follow this sequence:

1. **Analyze Fatigue:** Check local logs for the last muscle groups worked.
2. **RAG Retrieval:** Query ChromaDB using the `selected_creator` filter to find the "rules" for the day's focus.
3. **Drafting:** The Trainer Agent generates a plan using the retrieved context.
4. **Breakpoint:** Pause for user approval.
5. **Finalize:** The Nutritionist Agent calculates macros for the approved workout.


