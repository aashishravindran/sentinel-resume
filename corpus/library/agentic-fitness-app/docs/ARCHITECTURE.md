# Architecture Documentation

## Table of Contents

1. [System Overview](#system-overview)
2. [Architecture Diagram](#architecture-diagram)
3. [Core Components](#core-components)
4. [State Management](#state-management)
5. [Workflow & Data Flow](#workflow--data-flow)
6. [Safety & Governance](#safety--governance)
7. [Persistence Layer](#persistence-layer)
8. [Agent System](#agent-system)
9. [RAG System](#rag-system)
10. [CLI Interface](#cli-interface)
11. [Configuration](#configuration)
12. [Usage Examples](#usage-examples)

---

## System Overview

The **Agentic Fitness Platform** is a local-first, multi-agent fitness coaching system that uses Retrieval-Augmented Generation (RAG) to provide personalized workouts grounded in creator philosophies. The system features:

- **Hierarchical Multi-Agent Architecture**: Supervisor routes to specialized worker agents
- **Safety Governor**: Prevents overtraining through fatigue thresholds and weekly limits
- **Persistent State**: SQLite-based checkpointing for user history and fatigue tracking
- **History-Based Fatigue**: Automatically adjusts fatigue based on previous workouts
- **Recovery Management**: Dedicated recovery worker for rest days and active recovery

### Key Technologies

- **LangGraph**: Workflow orchestration and state management
- **PydanticAI**: Type-safe, structured LLM outputs
- **ChromaDB**: Local vector database for RAG
- **Ollama**: Local embeddings (`mxbai-embed-large`)
- **Gemini/OpenAI**: LLM providers for agent reasoning
- **SQLite**: Persistent checkpointing via `SqliteSaver`

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                      User Interface (CLI)                     │
│                    python main.py chat                      │
└────────────────────────┬──────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                    Supervisor Node                           │
│  • Safety Override (fatigue > threshold → recovery)         │
│  • Frequency Block (weekly limit → end)                      │
│  • Persona Detection & Routing                               │
│  • Fatigue Complaint Mapping                                 │
└────────────────────────┬──────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                      Decay Node                              │
│  • Time-based fatigue decay (3% per hour)                    │
│  • Weekly counter reset (after 7 days)                       │
└────────────────────────┬──────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                 History Analysis Node                        │
│  • Analyze last workout from history                         │
│  • Apply fatigue penalties based on previous session          │
└────────────────────────┬──────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│              Conditional Routing (Supervisor Decision)       │
│  ┌──────────┬──────────┬──────────┬──────────┬──────────┐  │
│  │  Iron    │  Yoga    │   HIIT   │ Kickbox  │ Recovery │  │
│  │ Worker   │ Worker   │ Worker   │ Worker   │ Worker   │  │
│  └──────────┴──────────┴──────────┴──────────┴──────────┘  │
└─────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                    Worker Nodes                              │
│  • Retrieve creator philosophy from RAG                       │
│  • Generate structured workout plan                          │
│  • Save to workout_history                                   │
│  • Increment workouts_completed_this_week                    │
└────────────────────────┬──────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│              SQLite Checkpointer (Persistence)               │
│  • Save state to checkpoints/checkpoints.db                  │
│  • Thread-based isolation (user_id = thread_id)              │
│  • Automatic state loading on next session                   │
└─────────────────────────────────────────────────────────────┘
```

---

## Core Components

### 1. State Schema (`state.py`)

The `FitnessState` TypedDict defines the complete system state:

```python
class FitnessState(TypedDict):
    # Identity & Routing
    user_id: str
    selected_persona: Literal["iron", "yoga", "hiit", "kickboxing"]
    selected_creator: str  # Legacy compatibility
    next_node: str  # Set by supervisor for routing
    
    # Persistent State
    fatigue_scores: Dict[str, float]  # Muscle group fatigue (0.0-1.0)
    last_session_timestamp: float  # Unix timestamp
    workout_history: List[Dict]  # Previous workout JSONs
    
    # Safety & Frequency Constraints
    max_workouts_per_week: int  # User's target frequency (default: 4)
    workouts_completed_this_week: int  # Counter for current period
    fatigue_threshold: float  # Recovery trigger (default: 0.8)
    
    # Context
    messages: List[Dict[str, str]]  # Conversation history
    active_philosophy: Optional[str]  # RAG context
    retrieved_rules: List[str]  # Legacy RAG chunks
    retrieved_philosophy: str  # Legacy combined text
    
    # Workout Output
    goal: str  # User's fitness goal
    current_workout: Optional[str]  # Legacy JSON string
    daily_workout: Optional[Dict]  # Structured workout plan
    is_approved: bool  # HITL status
```

### 2. Supervisor Node (`agents/supervisor.py`)

**Role**: Entry point and Safety Governor

**Responsibilities**:
- Process user messages and conversation
- Detect persona switching
- Map fatigue complaints to scores
- **Safety Override**: Force recovery if `max(fatigue_scores) > fatigue_threshold`
- **Frequency Block**: End session if `workouts_completed_this_week >= max_workouts_per_week`
- Route to appropriate worker or recovery

**Output**: `SupervisorDecision` with `next_node`, `selected_persona`, `fatigue_updates`, `reasoning`

### 3. Decay Node (`agents/decay.py`)

**Role**: Time-based fatigue reduction

**Logic**:
- Calculates hours since `last_session_timestamp`
- Applies exponential decay: `fatigue_new = fatigue_old * (0.97 ^ hours_passed)`
- Resets `workouts_completed_this_week` if 7+ days have passed

**Decay Rates**:
- 24 hours: ~52% reduction
- 48 hours: ~77% reduction
- 72 hours: ~89% reduction

### 4. History Analysis Node (`agents/history_analyzer.py`)

**Role**: Apply fatigue based on previous workout

**Logic**:
- Reads last workout from `workout_history`
- Analyzes `focus_area` and exercise names
- Applies fatigue penalties:
  - Strength: legs/push/pull → +0.3 fatigue
  - Yoga: spine/hips/shoulders → +0.25 fatigue
  - HIIT: cardio → +0.4, CNS → +0.3
  - Exercise-level analysis for additional signals

### 5. Worker Nodes (`agents/workers.py`)

**Specialized Agents**:

#### Iron Worker (Strength Training)
- **Focus**: push, pull, legs
- **Output**: `StrengthWorkoutPlan` with sets/reps/tempo
- **Philosophy**: Coach Iron's progressive overload principles

#### Yoga Worker (Mobility)
- **Focus**: spine, hips, shoulders
- **Output**: `YogaWorkoutPlan` with poses and durations
- **Philosophy**: ZenFlow Yoga's mindful movement

#### HIIT Worker (Cardio)
- **Focus**: cardio, CNS systems
- **Output**: `HIITWorkoutPlan` with intervals and zones
- **Philosophy**: Inferno HIIT's maximum effort principles

#### Kickboxing Worker (Combat Fitness)
- **Focus**: coordination, speed, power, endurance
- **Output**: `KickboxingWorkoutPlan` with rounds and intensity
- **Philosophy**: Strikeforce's technique-first approach

**Common Behavior**:
- Retrieve creator philosophy from RAG
- Generate structured workout using PydanticAI
- Append workout to `workout_history`
- Increment `workouts_completed_this_week`

### 6. Recovery Worker (`agents/recovery_worker.py`)

**Role**: Rest and recovery specialist

**Logic Tiers**:
- **Extreme Fatigue (>0.8)**: Passive recovery (sleep, rest, hydration)
- **Moderate (0.6-0.8)**: Active recovery (walking, gentle mobility, foam rolling)
- **Mild (<0.6)**: NEAT activities (fun movement, step goals 4K-6K)

**Output**: `RecoveryPlan` with activities, step goals, and "permission to rest" messaging

**Note**: Recovery sessions do NOT increment `workouts_completed_this_week`

---

## State Management

### State Flow

1. **Initial State**: Built in `run_workout()` with defaults
2. **Persistence Load**: Existing state loaded from SQLite (if available)
3. **Supervisor**: Updates `fatigue_scores`, sets `next_node`
4. **Decay**: Reduces fatigue, resets weekly counter if needed
5. **History Analysis**: Adds fatigue based on previous workout
6. **Worker**: Generates workout, saves to history, increments counter
7. **Persistence Save**: State saved to SQLite via LangGraph checkpointer

### State Merging

When loading persisted state:
- `workout_history` is preserved (critical for history analysis)
- `fatigue_scores` are merged (persisted + provided)
- Safety settings (`max_workouts_per_week`, `fatigue_threshold`) are preserved
- `workouts_completed_this_week` is preserved

---

## Workflow & Data Flow

### Complete Workflow

```
1. User Request
   ↓
2. Supervisor Node
   ├─ Safety Check: max_fatigue > threshold? → recovery_worker
   ├─ Frequency Check: workouts >= max? → end
   └─ Normal Routing: → selected worker
   ↓
3. Decay Node
   ├─ Apply time-based fatigue decay
   └─ Reset weekly counter if 7+ days passed
   ↓
4. History Analysis Node
   ├─ Read last workout from history
   └─ Apply fatigue penalties
   ↓
5. Worker Node (or Recovery)
   ├─ Retrieve creator philosophy from RAG
   ├─ Generate structured workout
   ├─ Append to workout_history
   └─ Increment workouts_completed_this_week
   ↓
6. Persistence
   └─ Save state to SQLite via checkpointer
```

### Example: High Fatigue Scenario

```
User: "I want a strength workout"
State: fatigue_scores = {"legs": 0.85, "push": 0.2}
       fatigue_threshold = 0.8

Supervisor:
  ├─ max_fatigue = 0.85
  ├─ 0.85 > 0.8? YES
  └─ SAFETY OVERRIDE: next_node = "recovery_worker"
  
Result: Recovery plan generated instead of strength workout
```

### Example: Weekly Limit Scenario

```
State: workouts_completed_this_week = 4
       max_workouts_per_week = 4

Supervisor:
  ├─ 4 >= 4? YES
  └─ FREQUENCY BLOCK: next_node = "end"
  
Result: Session terminated with message explaining weekly limit reached
```

---

## Safety & Governance

### Safety Override

**Trigger**: `max(fatigue_scores.values()) > fatigue_threshold`

**Action**: Supervisor forces routing to `recovery_worker`, ignoring user request

**Rationale**: Prevents overtraining and injury risk

**Configurable**: `fatigue_threshold` (default: 0.8) can be adjusted per user

### Frequency Block

**Trigger**: `workouts_completed_this_week >= max_workouts_per_week`

**Action**: Supervisor routes to `end`, terminating the session

**Rationale**: Enforces weekly recovery and prevents overtraining

**Configurable**: `max_workouts_per_week` (default: 4) can be adjusted per user

### Automatic Recovery

**Recovery Worker** is automatically invoked when:
1. Fatigue exceeds threshold (safety override)
2. User explicitly requests rest/recovery
3. Weekly limit reached (suggests recovery)

---

## Persistence Layer

### SQLite Checkpointing

**Location**: `checkpoints/checkpoints.db`

**Isolation**: Each `user_id` maps to a unique `thread_id` for state isolation

**Automatic Loading**: LangGraph automatically loads persisted state when `invoke()` is called with a `thread_id`

**State Preservation**:
- `workout_history`: Complete workout history
- `fatigue_scores`: Current fatigue levels
- `workouts_completed_this_week`: Weekly counter
- `max_workouts_per_week`: User's frequency target
- `fatigue_threshold`: User's safety threshold
- All other state fields

### Database Utilities (`db_utils.py`)

**Functions**:
- `list_users()`: List all user IDs in database
- `get_user_state()`: Retrieve user state
- `update_user_fatigue()`: Update fatigue scores
- `update_workouts_completed()`: Update weekly counter
- `update_max_workouts()`: Update weekly limit
- `update_fatigue_threshold()`: Update safety threshold
- `clear_user_history()`: Clear workout history
- `delete_user()`: Delete all user data
- `export_user_state()`: Export to JSON

---

## Agent System

### Agent Architecture

All agents use **PydanticAI** for structured outputs:

1. **Model Selection**: Prioritizes Gemini → OpenAI → Ollama
2. **Structured Output**: Pydantic models ensure type safety
3. **System Prompts**: Each agent has domain-specific instructions
4. **RAG Integration**: Workers retrieve creator philosophy before generation

### Agent Types

| Agent | Model | Output Type | Philosophy Source |
|-------|-------|-------------|-------------------|
| Supervisor | Gemini/OpenAI | `SupervisorDecision` | Built-in routing logic |
| Iron Worker | Gemini/OpenAI | `StrengthWorkoutPlan` | `coach_iron.md` |
| Yoga Worker | Gemini/OpenAI | `YogaWorkoutPlan` | `zenflow_yoga.md` |
| HIIT Worker | Gemini/OpenAI | `HIITWorkoutPlan` | `inferno_hiit.md` |
| Kickboxing Worker | Gemini/OpenAI | `KickboxingWorkoutPlan` | `strikeforce_kb.md` |
| Recovery Worker | Gemini/OpenAI | `RecoveryPlan` | Built-in recovery logic |

### LLM Configuration

**Priority Order**:
1. Gemini (via `GOOGLE_API_KEY`)
2. OpenAI (via `OPENAI_API_KEY`)
3. Ollama (local, via `OLLAMA_BASE_URL`)

**Model Selection**:
- Default: `gemini-flash-latest`
- Fallback chain: `gemini-2.0-flash` → `gemini-2.5-flash` → `gemini-1.5-pro` → `gemini-1.0-pro`
- Configurable via `GEMINI_MODEL` in `.env`

---

## RAG System

### Ingestion (`ingest.py`)

**Process**:
1. Iterate through `creators/` directory
2. Chunk markdown files (900 chars, 120 overlap)
3. Embed using Ollama (`mxbai-embed-large`)
4. Store in ChromaDB with `creator_name` metadata

**Command**:
```bash
python main.py ingest
```

### Retrieval (`agents/retriever.py`)

**Function**: `retrieve_creator_rules(query, selected_creator, k=8)`

**Process**:
1. Query ChromaDB with `creator_name` filter
2. Return top-k relevant chunks
3. Used by workers to ground generation in creator philosophy

**Vector Store**: ChromaDB with persistent storage in `creator_db/`

---

## CLI Interface

### Complete Command Reference

The CLI provides five main command categories: `ingest`, `query`, `train`, `chat`, and `db`. All commands are accessed via `python main.py <command> [options]`.

---

### 1. Ingest Command

**Purpose**: Populate ChromaDB vector store with creator philosophy documents.

**Basic Usage**:
```bash
python main.py ingest
```

**Full Syntax**:
```bash
python main.py ingest [OPTIONS]
```

**Options**:
- `--creators-dir PATH` - Directory containing creator `.md` files (default: `./creators`)
- `--persist-dir PATH` - ChromaDB persistence directory (default: `./creator_db`)
- `--collection NAME` - ChromaDB collection name (default: `creator_rules`)
- `--ollama-url URL` - Ollama base URL (default: `http://localhost:11434`)
- `--embed-model MODEL` - Ollama embedding model (default: `mxbai-embed-large`)
- `--chunk-size SIZE` - Character chunk size (default: `900`)
- `--chunk-overlap OVERLAP` - Character overlap between chunks (default: `120`)

**Examples**:
```bash
# Basic ingestion with defaults
python main.py ingest

# Custom directory and chunking
python main.py ingest --creators-dir ./my_creators --chunk-size 1000 --chunk-overlap 150

# Custom Ollama endpoint
python main.py ingest --ollama-url http://192.168.1.100:11434
```

**Output**: Prints number of chunks ingested, e.g., `"Ingested 45 chunks into collection 'creator_rules'."`

---

### 2. Query Command

**Purpose**: Query the RAG system to retrieve creator philosophy chunks.

**Basic Usage**:
```bash
python main.py query --creator coach_iron --query "What are your key rules?"
```

**Full Syntax**:
```bash
python main.py query [OPTIONS]
```

**Options**:
- `--creator NAME` - Creator name (file stem without `.md`) (default: `coach_iron`)
  - Valid values: `coach_iron`, `zenflow_yoga`, `inferno_hiit`, `strikeforce_kb`
- `--query TEXT` - Query text for semantic search (default: `"What are your key programming rules?"`)
- `--k NUMBER` - Number of top chunks to return (default: `6`)
- `--persist-dir PATH` - ChromaDB persistence directory (default: `./creator_db`)
- `--collection NAME` - ChromaDB collection name (default: `creator_rules`)
- `--ollama-url URL` - Ollama base URL (default: `http://localhost:11434`)
- `--embed-model MODEL` - Ollama embedding model (default: `mxbai-embed-large`)

**Examples**:
```bash
# Query Coach Iron's philosophy
python main.py query --creator coach_iron --query "How should I handle fatigue?"

# Get more results
python main.py query --creator zenflow_yoga --query "What are your core principles?" --k 10

# Query different creator
python main.py query --creator inferno_hiit --query "What is your training philosophy?"
```

**Output**: Displays top-k retrieved chunks with similarity scores and metadata.

---

### 3. Train Command

**Purpose**: Generate a workout using the legacy Trainer Agent (single-agent, not multi-agent).

**Basic Usage**:
```bash
python main.py train --creator coach_iron --goal "Build strength"
```

**Full Syntax**:
```bash
python main.py train [OPTIONS]
```

**Options**:
- `--creator NAME` - Creator name (default: `coach_iron`)
- `--goal TEXT` - User fitness goal (default: `"Build strength and muscle mass"`)
- `--fatigue SCORES` - Fatigue scores as comma-separated key:value pairs (default: `"legs:0.2,push:0.2,pull:0.2"`)
  - Format: `"key1:value1,key2:value2"` (e.g., `"legs:0.8,push:0.2"`)
- `--user-id ID` - User ID (default: `user_123`)
- `--json` - Output workout as JSON instead of formatted text

**Examples**:
```bash
# Basic workout generation
python main.py train --creator coach_iron --goal "Build muscle"

# With fatigue scores
python main.py train --fatigue "legs:0.7,push:0.3,pull:0.1" --goal "Upper body focus"

# JSON output for programmatic use
python main.py train --json --creator zenflow_yoga --goal "Improve flexibility"
```

**Output**: Displays formatted workout with exercises, sets, reps, tempo, and Iron Reasoning justifications.

---

### 4. Chat Command (Main Interface)

**Purpose**: Natural language interface to the multi-agent system. Routes through Supervisor → Decay → History Analysis → Workers.

**Basic Usage**:
```bash
python main.py chat "I want a strength workout, my legs are sore" --user-id aashish_ravindran
```

**Full Syntax**:
```bash
python main.py chat [QUERY] [OPTIONS]
```

**Arguments**:
- `QUERY` (optional) - Natural language request (default: `""`)
  - Examples: `"I want a yoga session"`, `"Give me a HIIT workout"`, `"My shoulders are tight"`

**Options**:
- `--persona PERSONA` - Default persona if not inferred from query (default: `iron`)
  - Choices: `iron`, `yoga`, `hiit`, `kickboxing`
- `--goal TEXT` - Fitness goal (default: `"Build strength and improve fitness"`)
- `--fatigue SCORES` - Initial fatigue scores (default: `""`)
  - Format: `"key1:value1,key2:value2"` (e.g., `"legs:0.7,push:0.2"`)
- `--user-id ID` - User ID for persistent state (default: `cli_user`)
  - **Important**: Same `user_id` = same history, fatigue, and safety settings across sessions
- `--json` - Output workout as JSON instead of formatted text

**Examples**:
```bash
# Natural language query
python main.py chat "I want a strength workout, my legs are sore" --user-id aashish_ravindran

# Explicit persona
python main.py chat "Give me a workout" --persona yoga --user-id user_123

# With initial fatigue
python main.py chat "Upper body workout" --fatigue "legs:0.8,push:0.1" --user-id test_user

# JSON output
python main.py chat "HIIT session" --json --user-id api_user

# Recovery request
python main.py chat "I need a rest day" --user-id aashish_ravindran
```

**Output**: 
- Displays user ID, weekly progress, fatigue threshold, and safety alerts
- Shows generated workout or recovery plan
- Automatically saves state to SQLite for next session

**Safety Features**:
- If `max_fatigue > fatigue_threshold`: Automatically routes to recovery worker
- If `workouts_completed_this_week >= max_workouts_per_week`: Session ends with limit message

---

### 5. Database Management Commands (`db`)

**Purpose**: Manage persistent user state, fatigue scores, safety settings, and workout history.

All database commands follow the pattern: `python main.py db <subcommand> [arguments]`

#### 5.1. List Users

**Purpose**: List all user IDs in the database.

**Syntax**:
```bash
python main.py db list
```

**Output**: Prints all `user_id` values found in `checkpoints/checkpoints.db`.

**Example**:
```bash
python main.py db list
# Output:
# Users in database:
# - aashish_ravindran
# - test_user
# - api_user
```

---

#### 5.2. View User State

**Purpose**: Display complete user state including fatigue, history, and safety settings.

**Syntax**:
```bash
python main.py db view <user_id>
```

**Arguments**:
- `user_id` (required) - User ID to view

**Output**: Displays:
- Fatigue scores (all muscle groups)
- Weekly progress (`workouts_completed_this_week` / `max_workouts_per_week`)
- Fatigue threshold
- Last session timestamp
- Workout history (last 5 workouts with focus areas)

**Example**:
```bash
python main.py db view aashish_ravindran
```

---

#### 5.3. Update Fatigue Scores

**Purpose**: Update fatigue scores for specific muscle groups.

**Syntax**:
```bash
python main.py db update-fatigue <user_id> <fatigue_scores>
```

**Arguments**:
- `user_id` (required) - User ID
- `fatigue_scores` (required) - Comma-separated key:value pairs
  - Format: `"key1:value1,key2:value2"`
  - Values must be between 0.0 and 1.0

**Examples**:
```bash
# Update single muscle group
python main.py db update-fatigue aashish_ravindran "legs:0.8"

# Update multiple groups
python main.py db update-fatigue aashish_ravindran "legs:0.7,push:0.3,pull:0.1"

# Set high fatigue (triggers recovery on next chat)
python main.py db update-fatigue aashish_ravindran "legs:0.9,spine:0.85"
```

**Note**: Only updates specified muscle groups; others remain unchanged.

---

#### 5.4. Update Workouts Completed

**Purpose**: Manually set the `workouts_completed_this_week` counter.

**Syntax**:
```bash
python main.py db update-workouts <user_id> <count>
```

**Arguments**:
- `user_id` (required) - User ID
- `count` (required) - Number of workouts completed this week (integer)

**Examples**:
```bash
# Set to 3 workouts
python main.py db update-workouts aashish_ravindran 3

# Reset to 0
python main.py db update-workouts aashish_ravindran 0

# Set to max (triggers frequency block)
python main.py db update-workouts aashish_ravindran 4
```

**Note**: Counter automatically resets after 7 days (handled by Decay Node).

---

#### 5.5. Update Max Workouts Per Week

**Purpose**: Set the weekly workout frequency limit.

**Syntax**:
```bash
python main.py db update-max-workouts <user_id> <max>
```

**Arguments**:
- `user_id` (required) - User ID
- `max` (required) - Maximum workouts per week (integer, typically 3-6)

**Examples**:
```bash
# Conservative (3 workouts/week)
python main.py db update-max-workouts aashish_ravindran 3

# Default (4 workouts/week)
python main.py db update-max-workouts aashish_ravindran 4

# Aggressive (6 workouts/week)
python main.py db update-max-workouts aashish_ravindran 6
```

**Note**: When `workouts_completed_this_week >= max`, Supervisor routes to `end`.

---

#### 5.6. Update Fatigue Threshold

**Purpose**: Set the fatigue threshold that triggers automatic recovery.

**Syntax**:
```bash
python main.py db update-threshold <user_id> <threshold>
```

**Arguments**:
- `user_id` (required) - User ID
- `threshold` (required) - Fatigue threshold (float, 0.0 to 1.0, default: 0.8)

**Examples**:
```bash
# Conservative (recovery at 70% fatigue)
python main.py db update-threshold aashish_ravindran 0.7

# Default (recovery at 80% fatigue)
python main.py db update-threshold aashish_ravindran 0.8

# Aggressive (recovery at 90% fatigue)
python main.py db update-threshold aashish_ravindran 0.9
```

**Note**: Lower threshold = more conservative (earlier recovery), higher = more aggressive.

---

#### 5.7. Clear Workout History

**Purpose**: Delete all workout history for a user (fatigue scores and other state preserved).

**Syntax**:
```bash
python main.py db clear-history <user_id>
```

**Arguments**:
- `user_id` (required) - User ID

**Example**:
```bash
python main.py db clear-history aashish_ravindran
```

**Note**: This only clears `workout_history`; fatigue scores, safety settings, and other state remain.

---

#### 5.8. Delete User

**Purpose**: Completely remove a user and all associated data from the database.

**Syntax**:
```bash
python main.py db delete <user_id>
```

**Arguments**:
- `user_id` (required) - User ID to delete

**Example**:
```bash
python main.py db delete aashish_ravindran
```

**Warning**: This permanently deletes all user data including history, fatigue, and safety settings. Use with caution.

**Use Case**: Useful for resetting corrupted checkpoints or removing test users.

---

#### 5.9. Export User State

**Purpose**: Export complete user state to a JSON file for backup or analysis.

**Syntax**:
```bash
python main.py db export <user_id> <output_file>
```

**Arguments**:
- `user_id` (required) - User ID to export
- `output_file` (required) - Output JSON file path

**Examples**:
```bash
# Export to current directory
python main.py db export aashish_ravindran user_backup.json

# Export to specific path
python main.py db export aashish_ravindran ~/backups/user_2025-01-22.json
```

**Output**: Creates a JSON file containing:
- Fatigue scores
- Workout history
- Safety settings
- Last session timestamp
- All other state fields

**Use Case**: Backup, migration, or external analysis.

---

### Command Quick Reference

| Command | Purpose | Key Options |
|---------|---------|-------------|
| `ingest` | Populate RAG vector store | `--creators-dir`, `--chunk-size` |
| `query` | Query RAG system | `--creator`, `--query`, `--k` |
| `train` | Legacy trainer agent | `--creator`, `--fatigue`, `--goal` |
| `chat` | Multi-agent workout generation | `--user-id`, `--persona`, `--fatigue` |
| `db list` | List all users | None |
| `db view` | View user state | `<user_id>` |
| `db update-fatigue` | Update fatigue scores | `<user_id> <scores>` |
| `db update-workouts` | Set workout counter | `<user_id> <count>` |
| `db update-max-workouts` | Set weekly limit | `<user_id> <max>` |
| `db update-threshold` | Set fatigue threshold | `<user_id> <0.0-1.0>` |
| `db clear-history` | Clear workout history | `<user_id>` |
| `db delete` | Delete user | `<user_id>` |
| `db export` | Export to JSON | `<user_id> <file>` |

---

### Common Workflows

#### Workflow 1: First-Time Setup
```bash
# 1. Ingest creator philosophies
python main.py ingest

# 2. Test RAG retrieval
python main.py query --creator coach_iron --query "What are your principles?"

# 3. Generate first workout
python main.py chat "I want a strength workout" --user-id my_user_id
```

#### Workflow 2: Daily Workout Generation
```bash
# Generate workout (automatically loads history and fatigue)
python main.py chat "Leg day workout" --user-id aashish_ravindran

# If recovery needed, system automatically suggests it
```

#### Workflow 3: Manual Fatigue Management
```bash
# Check current state
python main.py db view aashish_ravindran

# Update fatigue after intense session
python main.py db update-fatigue aashish_ravindran "legs:0.9,push:0.2"

# Next workout will account for high fatigue
python main.py chat "Upper body workout" --user-id aashish_ravindran
```

#### Workflow 4: Safety Customization
```bash
# Make system more conservative
python main.py db update-threshold aashish_ravindran 0.7
python main.py db update-max-workouts aashish_ravindran 3

# Verify settings
python main.py db view aashish_ravindran
```

#### Workflow 5: Reset User
```bash
# Export backup first
python main.py db export aashish_ravindran backup.json

# Delete user
python main.py db delete aashish_ravindran

# Start fresh
python main.py chat "First workout" --user-id aashish_ravindran
```

---

## Configuration

### Environment Variables (`.env`)

```bash
# Gemini API (Recommended)
GOOGLE_API_KEY=your-api-key
GEMINI_MODEL=gemini-flash-latest

# OpenAI (Alternative)
OPENAI_API_KEY=sk-your-key

# Ollama (Local Fallback)
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2
```

### Default Settings

- `max_workouts_per_week`: 4
- `fatigue_threshold`: 0.8
- `workouts_completed_this_week`: 0 (resets after 7 days)
- Decay rate: 3% per hour (0.97 factor)

### Per-User Customization

All safety settings can be customized per user via database commands:
- `update-max-workouts`: Adjust weekly frequency
- `update-threshold`: Adjust fatigue sensitivity
- `update-workouts`: Manually set workout count

---

## Usage Examples

### Example 1: Normal Workout Flow

```bash
# Generate a strength workout
python main.py chat "I want a strength workout focusing on legs" \
  --user-id aashish_ravindran \
  --persona iron

# Output: Strength workout with leg-focused exercises
# State: workout saved to history, counter incremented
```

### Example 2: Safety Override

```bash
# Set high fatigue
python main.py db update-fatigue aashish_ravindran "legs:0.85"

# Request strength workout (will be overridden)
python main.py chat "I want a strength workout" \
  --user-id aashish_ravindran

# Output: Recovery plan (safety override triggered)
```

### Example 3: Weekly Limit

```bash
# Set workouts to max
python main.py db update-workouts aashish_ravindran 4

# Try to generate workout
python main.py chat "I want a workout" \
  --user-id aashish_ravindran

# Output: Session ended (weekly limit reached)
```

### Example 4: History-Based Fatigue

```bash
# Day 1: Leg workout
python main.py chat "Leg day" --user-id test

# Day 2: Request another workout
python main.py chat "Upper body workout" --user-id test

# Result: History analysis adds +0.3 to legs fatigue
#         System may suggest avoiding legs or recovery
```

### Example 5: Recovery Session

```bash
# Explicit recovery request
python main.py chat "I need a rest day" \
  --user-id aashish_ravindran

# Output: Recovery plan with activities
# Note: Does NOT increment workouts_completed_this_week
```

### Example 6: Custom Safety Settings

```bash
# Make system more conservative
python main.py db update-threshold aashish_ravindran 0.7
python main.py db update-max-workouts aashish_ravindran 3

# System will now:
# - Trigger recovery at 70% fatigue (instead of 80%)
# - Block workouts after 3 sessions (instead of 4)
```

---

## File Structure

```
agentic-fitness-app/
├── agents/
│   ├── decay.py              # Time-based fatigue decay
│   ├── history_analyzer.py   # History-based fatigue penalties
│   ├── recovery_worker.py    # Recovery and rest day specialist
│   ├── retriever.py          # RAG retrieval functions
│   ├── supervisor.py         # Safety Governor & routing
│   ├── trainer.py             # Legacy trainer (single-agent)
│   └── workers.py             # Specialist workers (iron, yoga, hiit, kb)
├── creators/
│   ├── coach_iron.md         # Strength training philosophy
│   ├── zenflow_yoga.md       # Yoga/mobility philosophy
│   ├── inferno_hiit.md       # HIIT philosophy
│   └── strikeforce_kb.md    # Kickboxing philosophy
├── checkpoints/
│   └── checkpoints.db        # SQLite persistence (auto-created)
├── creator_db/               # ChromaDB vector store (auto-created)
├── config.py                 # Environment variable loader
├── db_utils.py               # Database management utilities
├── graph.py                  # LangGraph workflow definition
├── ingest.py                 # RAG ingestion script
├── main.py                   # CLI interface
├── state.py                  # FitnessState TypedDict
├── .env                      # Environment variables (user-created)
├── .env.example              # Environment template
├── requirements.txt          # Python dependencies
├── ARCHITECTURE.md           # This document
├── QUICKSTART.md             # Quick setup guide
├── PROJECT_DOCUMENTATION.md  # Detailed project docs
└── README.md                 # Project overview
```

---

## Key Design Decisions

### 1. Local-First Architecture

- **RAG**: ChromaDB + Ollama embeddings (no cloud dependencies)
- **Persistence**: SQLite (file-based, portable)
- **LLM**: Supports local Ollama as fallback

### 2. Safety-First Design

- **Proactive**: Safety checks happen before workout generation
- **Configurable**: Users can adjust thresholds
- **Automatic**: No manual intervention needed

### 3. History-Aware Fatigue

- **Contextual**: Previous workouts influence current state
- **Automatic**: No manual fatigue entry required
- **Accumulative**: Fatigue builds naturally across sessions

### 4. Structured Outputs

- **Type-Safe**: Pydantic models ensure consistency
- **Parseable**: JSON-friendly for frontend integration
- **Validated**: Field constraints prevent invalid data

### 5. Multi-Agent Specialization

- **Domain Expertise**: Each worker is specialized
- **Philosophy Grounding**: RAG ensures creator alignment
- **Flexible Routing**: Supervisor adapts to user needs

---

## Extension Points

### Future Enhancements

1. **Nutrition Agent**: Macro calculation based on workouts
2. **Periodization**: Long-term program planning
3. **Social Features**: Share workouts, compare progress
4. **Mobile App**: React Native frontend
5. **Advanced Analytics**: Progress tracking, trend analysis
6. **Multi-User Support**: Family/team accounts
7. **Integration**: Wearable device sync, calendar integration

### Customization

- **New Creators**: Add `.md` files to `creators/` and run `ingest`
- **New Workers**: Add worker function to `workers.py` and update graph
- **Custom Fatigue Groups**: Extend `fatigue_scores` dict
- **Custom Safety Rules**: Modify supervisor logic

---

## Troubleshooting

### Common Issues

1. **"ModuleNotFoundError: No module named 'config'"**
   - Solution: Ensure you're running from project root, or add root to `sys.path`

2. **"Gemini model not found"**
   - Solution: Update `GEMINI_MODEL` in `.env` to `gemini-flash-latest`

3. **"Corrupted checkpoint"**
   - Solution: Run `python main.py db delete <user_id>` to reset

4. **"Workout history not persisting"**
   - Solution: Ensure `langgraph-checkpoint-sqlite` is installed

5. **"Ollama connection refused"**
   - Solution: Start Ollama service: `ollama serve`

---

## Performance Considerations

### Latency

- **RAG Retrieval**: ~100-200ms (local ChromaDB)
- **LLM Generation**: 2-10s (depends on provider)
- **Total Workflow**: 3-15s end-to-end

### Storage

- **ChromaDB**: ~10-50MB per creator (depends on content)
- **SQLite**: ~1-10MB per user (depends on history length)
- **Typical**: <100MB total for 10 users

### Scalability

- **Concurrent Users**: Limited by SQLite (use PostgreSQL for production)
- **Vector Search**: ChromaDB handles 1000s of chunks efficiently
- **LLM Rate Limits**: Respect provider limits (Gemini: 60 RPM)

---

## Security & Privacy

### Data Privacy

- **Local Storage**: All data stored locally
- **No Cloud Sync**: No data leaves your machine
- **API Keys**: Stored in `.env` (gitignored)

### Best Practices

- **Backup**: Regularly export user state via `db export`
- **API Keys**: Never commit `.env` to version control
- **Database**: `checkpoints.db` contains user data (gitignored)

---

## API Reference

### Core Functions

#### `run_workout(user_id, persona, goal, fatigue_scores, messages, checkpoint_dir)`

Main entry point for workout generation.

**Returns**: Final state dict with `daily_workout`, `workout_history`, etc.

#### `build_graph(checkpoint_dir, enable_persistence)`

Builds and compiles the LangGraph workflow.

**Returns**: Compiled graph ready for `invoke()`

### Database Functions

See `db_utils.py` for complete API documentation.

---

## Conclusion

The Agentic Fitness Platform provides a comprehensive, safety-first approach to personalized fitness coaching. The hierarchical multi-agent architecture ensures specialized expertise while the Safety Governor prevents overtraining. Persistent state and history-based fatigue create a truly personalized experience that adapts to each user's unique needs and recovery patterns.
