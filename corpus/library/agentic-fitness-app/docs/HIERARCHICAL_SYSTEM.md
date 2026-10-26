# Hierarchical Multi-Agent System - Implementation Guide

## Overview

We've implemented a **hierarchical multi-agent fitness system** with:
- **Supervisor**: Routes requests and manages persona switching
- **4 Specialist Workers**: Iron (strength), Yoga (mobility), HIIT (cardio), Kickboxing (coordination)
- **Fatigue Decay**: Time-based recovery simulation
- **Persistent State**: SqliteSaver for state between sessions

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    User Request                          │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│              Decay Node (First)                         │
│  - Calculates time since last session                  │
│  - Applies exponential decay to fatigue scores         │
│  - Formula: fatigue * (0.97 ^ hours_passed)            │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│              Supervisor Node                            │
│  - Detects persona switching                           │
│  - Maps fatigue complaints to scores                   │
│  - Routes to appropriate worker                         │
└──────────────────────┬──────────────────────────────────┘
                       │
        ┌──────────────┼──────────────┬──────────────┐
        │              │              │              │
        ▼              ▼              ▼              ▼
┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐
│   Iron    │  │   Yoga    │  │   HIIT    │  │Kickboxing │
│  Worker   │  │  Worker   │  │  Worker   │  │  Worker   │
│           │  │           │  │           │  │           │
│ push/pull │  │spine/hips │  │cardio/cns │  │coord/speed│
│   legs    │  │shoulders  │  │           │  │           │
└───────────┘  └───────────┘  └───────────┘  └───────────┘
        │              │              │              │
        └──────────────┴──────────────┴──────────────┘
                       │
                       ▼
                   END (Workout Generated)
```

## Components

### 1. Decay Node (`agents/decay.py`)

**Purpose**: Apply time-based fatigue decay

**Formula**: `fatigue_new = fatigue_old * (0.97 ^ hours_passed)`

**Examples**:
- After 24 hours: ~52% reduction
- After 48 hours: ~77% reduction
- After 72 hours: ~89% reduction

**Runs**: FIRST in the graph (before supervisor)

### 2. Supervisor Node (`agents/supervisor.py`)

**Purpose**: Route requests and manage persona switching

**Capabilities**:
- Detects persona switching from user messages
- Maps natural language complaints to fatigue scores:
  - "my shins hurt" → `{"legs": 0.7}`
  - "shoulders are tight" → `{"shoulders": 0.6, "spine": 0.4}`
  - "I'm exhausted" → `{"cns": 0.8, "cardio": 0.6}`
- Routes to appropriate worker based on `selected_persona`

**Output**: `next_node` field in state

### 3. Worker Nodes (`agents/workers.py`)

Each worker:
- Retrieves their specific creator philosophy from ChromaDB
- Generates domain-specific workouts
- Returns structured Pydantic models

#### Iron Worker
- **Target**: push, pull, legs
- **Creator**: `coach_iron.md`
- **Output**: `StrengthWorkoutPlan` (sets/reps)

#### Yoga Worker
- **Target**: spine, hips, shoulders
- **Creator**: `zenflow_yoga.md`
- **Output**: `YogaWorkoutPlan` (duration-based)

#### HIIT Worker
- **Target**: cardio, cns
- **Creator**: `inferno_hiit.md`
- **Output**: `HIITWorkoutPlan` (work/rest intervals)

#### Kickboxing Worker
- **Target**: coordination, speed, power, endurance
- **Creator**: `strikeforce_kb.md`
- **Output**: `KickboxingWorkoutPlan` (round-based)

## Creator Files

All creator markdown files are in `creators/`:
- `coach_iron.md` - Strength training philosophy
- `zenflow_yoga.md` - Yoga/mobility philosophy
- `inferno_hiit.md` - HIIT/cardio philosophy
- `strikeforce_kb.md` - Kickboxing/combat fitness philosophy

## State Structure

Updated `FitnessState` includes:
- `selected_persona`: "iron", "yoga", "hiit", "kickboxing"
- `next_node`: Routing decision from supervisor
- `last_session_timestamp`: For fatigue decay
- `messages`: Conversation history
- `active_philosophy`: Retrieved creator philosophy

## How to Call the Supervisor Agent

**Option 1: Call the Supervisor directly** (routing + fatigue mapping only)

```python
from agents.supervisor import supervisor_node
from state import FitnessState
import time

state: FitnessState = {
    "user_id": "user_123",
    "selected_persona": "iron",
    "selected_creator": "iron",
    "next_node": "",
    "fatigue_scores": {"legs": 0.3, "push": 0.2},
    "last_session_timestamp": time.time(),
    "messages": [{"role": "user", "content": "I want yoga today, my hips are tight"}],
    "active_philosophy": None,
    "retrieved_rules": [],
    "retrieved_philosophy": "",
    "goal": "Build strength",
    "current_workout": None,
    "daily_workout": None,
    "is_approved": False,
}

updated = supervisor_node(state)
# updated["next_node"]     → "yoga_worker"
# updated["selected_persona"] → "yoga"
# updated["fatigue_scores"]   → may include mapped complaints (e.g. hips)
```

**Option 2: Run the full workflow** (Supervisor is the entry point → Decay → Worker → workout)

```python
from graph import run_workout

result = run_workout(
    user_id="user_123",
    persona="iron",
    goal="Build strength",
    fatigue_scores={"legs": 0.3, "push": 0.2},
    messages=[{"role": "user", "content": "I want a strength workout"}],
)
# result["daily_workout"] → full generated workout
```

**Run the example script:**

```bash
python examples/call_supervisor.py
```

---

## Usage

### 1. Ingest All Creators

```bash
python main.py ingest
```

This will index all 4 creator files into ChromaDB.

### 2. Run Graph

```python
from graph import run_workout

result = run_workout(
    user_id="user_123",
    persona="iron",
    goal="Build strength",
    fatigue_scores={"legs": 0.3, "push": 0.2},
    messages=[{"role": "user", "content": "I want a strength workout"}],
)
```

### 3. Test All Workers

```bash
python -m tests.test_graph
```

## Fatigue Mapping Between Personas

The supervisor handles cross-persona fatigue translation:

- **Iron's "legs"** → **Yoga's "hips/spine"** restriction
- **Iron's "push"** → **Yoga's "shoulders"** restriction
- **HIIT's "cardio"** → All personas should reduce intensity

## Persistence

State is persisted using `SqliteSaver` in `checkpoints/checkpoints.db`.

Each user has a `thread_id` (their `user_id`) that maintains state across sessions.

## Next Steps

1. **Add HITL Breakpoints**: User approval before finalizing workout
2. **Nutritionist Agent**: Calculate macros for generated workouts
3. **Fatigue Analysis Node**: Auto-calculate fatigue from workout history
4. **Web Interface**: React frontend for the graph
5. **Multi-User Support**: Proper user management and isolation

## Troubleshooting

### "No philosophy found"
- Run `python main.py ingest` first
- Check that creator files exist in `creators/`

### "Model not found"
- Set `GOOGLE_API_KEY` or `OPENAI_API_KEY`
- Or use Ollama (local)

### "Routing error"
- Check that `selected_persona` is one of: "iron", "yoga", "hiit", "kickboxing"
- Ensure supervisor has access to LLM
