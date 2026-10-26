# agentic-fitness-app

## Agentic Fitness Platform with AI Coaching

> 🚀 **New to the project? Start with [QUICKSTART.md](./docs/QUICKSTART.md) for CLI setup or [QUICKSTART_UI.md](./docs/QUICKSTART_UI.md) for API documentation.**
>
> 🎨 **UI:** The React frontend lives in a separate repo: [SuperSetUI](https://github.com/aashishravindran/SuperSetUI)
>
> 📖 **For comprehensive documentation, see [PROJECT_DOCUMENTATION.md](./docs/PROJECT_DOCUMENTATION.md)**

A full-stack fitness coaching platform powered by LangGraph agents, featuring:

- **RAG System**: Ingesting creator markdown files, chunking + embedding locally via Ollama, persisting to ChromaDB
- **Multi-Agent System**: Supervisor routes to specialist workers (Iron, Yoga, HIIT, Kickboxing)
- **Real-Time API**: WebSocket support for live workout sessions (consumed by [SuperSetUI](https://github.com/aashishravindran/SuperSetUI))
- **Fatigue Tracking**: Time-based decay, RPE-based accumulation, and rest day recovery
- **State Persistence**: SQLite checkpoints for per-user workout history and progress

### Setup

1. **Install Ollama** (for local embeddings + optional LLM):
   ```bash
   # macOS: brew install --cask ollama
   # Or download from: https://ollama.com
   
   # Pull embedding model
   ollama pull mxbai-embed-large
   
   # Pull language model (for trainer agent, if not using Gemini/OpenAI)
   ollama pull llama3.2  # Optional: only needed if using local Ollama
   ```

2. **Install Python dependencies** (use **uv** for fast installs, or pip):
   ```bash
   # Recommended: uv (install with: curl -LsSf https://astral.sh/uv/install.sh | sh)
   uv pip install -r requirements.txt

   # Or with pip
   pip install -r requirements.txt
   ```

3. **Set Gemini API key** (recommended) or use Ollama/OpenAI:
   
   **Option A: Use .env file (Recommended)**
   ```bash
   # Copy the example file
   cp .env.example .env
   
   # Edit .env and add your API key
   # GOOGLE_API_KEY=your-google-api-key-here
   ```
   
   **Option B: Environment variables**
   ```bash
   export GOOGLE_API_KEY="your-google-api-key-here"
   # Or: export GEMINI_API_KEY="your-key-here"
   ```
   
   **Alternative: OpenAI**
   ```bash
   export OPENAI_API_KEY="sk-your-key-here"
   ```
   
   **Alternative: Ollama (local, no API key needed)**
   ```bash
   # Just make sure Ollama is running
   ```

   **Alternative: DeepSeek**
   ```bash
   export LLM_PROVIDER=deepseek
   export DEEPSEEK_API_KEY=your-deepseek-api-key
   # Optional: DEEPSEEK_MODEL=deepseek-chat  (or deepseek-reasoner)
   ```
   Get a key: https://platform.deepseek.com

   **Alternative: AWS Bedrock**
   ```bash
   export LLM_PROVIDER=bedrock
   export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_DEFAULT_REGION=us-east-1
   # Optional: BEDROCK_MODEL=anthropic.claude-3-5-sonnet-20241022-v2:0
   ```

   **Swapping LLM provider**: Set `LLM_PROVIDER=gemini|openai|bedrock|ollama|deepseek` to force a backend. See `llm.py` and **[GEMINI_SETUP.md](./docs/GEMINI_SETUP.md)**.

   **Get a Gemini API key**: https://makersuite.google.com/app/apikey

## Quick Start

### Backend API

1. **Install dependencies**:
   ```bash
   uv pip install -r requirements.txt
   # Or: pip install -r requirements.txt
   ```

2. **Start backend**:
   ```bash
   python -m uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
   ```

3. **Use the UI**: Point [SuperSetUI](https://github.com/aashishravindran/SuperSetUI) at `http://localhost:8000`, or use the CLI below.

### SuperSet CLI (AWS CLI-style)

An AWS CLI-style tool that calls the REST API. Requires the backend to be running.

```bash
# Make it executable
chmod +x superset

# See all available endpoints
./superset help

# Configure defaults (saves to ~/.superset/config.json)
./superset configure --url http://localhost:8000 --user alice

# Onboard a user
./superset users intake alice --fitness-level Beginner \
  --about-me "I train at home" --equipment dumbbells,bands
./superset users accept alice

# Check profile and status
./superset users profile alice
./superset users status alice

# Generate and complete a workout
./superset workout generate alice --prompt "Give me a leg workout"
./superset workout log-set alice --exercise "Squat" --weight 100 --reps 8 --rpe 7
./superset workout finish alice
./superset workout history alice

# Update settings
./superset users settings alice --max-workouts 5 --duration 45 --equipment dumbbells,barbell

# Chat with Max (Q&A + commands)
./superset chat alice "How are my legs doing?"
./superset chat alice "Reset my fatigue"

# Resets
./superset reset fatigue alice
./superset reset workouts alice

# Any command with --json for raw output
./superset users profile alice --json
```

### Internal CLI (main.py)

**Direct graph/DB access for testing and development (no backend needed):**

#### RAG System (Ingest + Query)

- **Ingest creator data**:
  ```bash
  python main.py ingest
  ```

- **Query RAG** (filtered by creator):
  ```bash
  python main.py query --creator coach_iron --query "How should I adjust training when fatigue is high?"
  ```

#### Interactive Chat CLI

- **Chat with the agent** (natural language):
  ```bash
  python main.py chat "I want a strength workout, my legs are a bit sore"
  python main.py chat "Give me a yoga flow, my hips are tight"
  python main.py chat "HIIT session please" --persona hiit
  ```

- **View user state**:
  ```bash
  python main.py db view <user_id>
  python main.py db list
  ```

See **[QUICKSTART.md](./docs/QUICKSTART.md)** for detailed CLI instructions.

## Features

### 🎯 Multi-Agent Coaching System

**Supervisor** routes to **4 specialist workers**:
- **Iron Worker**: Strength training (push/pull/legs)
- **Yoga Worker**: Mobility (spine/hips/shoulders)
- **HIIT Worker**: Cardio (cardio/cns)
- **Kickboxing Worker**: Combat fitness (coordination/speed)

### 📊 Fatigue Management

- **Time-based decay**: Fatigue reduces automatically over time (3% per hour). Can be disabled via `feature_flags.ENABLE_DECAY = False`.
- **History-based fatigue**: Previous workout fatigue is applied in the graph. Can be disabled via `feature_flags.ENABLE_HISTORY_ANALYZER = False`.
- **RPE-based accumulation**: Log sets with RPE to build realistic fatigue
- **Rest day logging**: Log rest days to reduce fatigue by 30%
- **Fatigue reset**: Reset fatigue scores manually when needed

### 💪 Workout Features

- **Real-time generation**: Get workouts instantly via natural language
- **Set logging**: Log sets with weight, reps, and RPE
- **Workout history**: All workouts saved automatically
- **Weekly tracking**: Track workouts completed per week
- **Persona switching**: Switch between Iron/Yoga/HIIT/Kickboxing on the fly

### 🔒 User Management

- **Per-user state**: Each user has isolated workout history and fatigue
- **Start fresh**: Option to reset user state when logging in
- **Switch users**: Easily switch between users with proper state clearing

See **[HIERARCHICAL_SYSTEM.md](./docs/HIERARCHICAL_SYSTEM.md)** for agent system details.

## Architecture

### Components

- **Backend (FastAPI)**: WebSocket server for real-time workout sessions, REST API for status/history/settings
- **Agents (LangGraph)**: Multi-agent system with Supervisor, Workers, Decay, and History Analysis nodes
- **Persistence**: SQLite checkpoints for user state, ChromaDB for RAG storage

*UI: [SuperSetUI](https://github.com/aashishravindran/SuperSetUI) – separate React frontend*

### Project Structure

```
agentic-fitness-app/
├── backend/                # FastAPI Application
│   ├── main.py            # API entry point & WebSocket handlers
│   ├── routes/            # REST endpoints (status, history, settings)
│   └── services/          # LangGraph integration layer
├── agents/                # LangGraph Agents
│   ├── supervisor.py      # Safety Governor & Router
│   ├── workers.py         # Specialist Workers (Iron, Yoga, HIIT, Kickboxing)
│   ├── decay.py           # Time-based fatigue decay
│   ├── history_analyzer.py # History-based fatigue analysis
│   ├── finalize_workout.py # RPE-based fatigue application
│   └── log_rest.py        # Rest day logging
├── creators/              # Creator philosophy markdown files
├── docs/                  # Documentation (.md except README)
├── tests/                 # Test suite (test_graph, test_trainer)
├── creator_db/            # ChromaDB persistence (auto-created)
├── checkpoints/           # SQLite checkpoints (auto-created)
├── graph.py               # LangGraph workflow definition
├── llm.py                 # LLM client interface (Gemini/OpenAI/Bedrock/Ollama/DeepSeek)
├── feature_flags.py       # Feature flags (decay, history_analyzer)
├── state.py               # Shared FitnessState TypedDict
└── main.py                # CLI interface
```

## Documentation

### Getting Started
- **[QUICKSTART.md](./docs/QUICKSTART.md)** - CLI setup and usage guide
- **[QUICKSTART_UI.md](./docs/QUICKSTART_UI.md)** - API setup and curl/WebSocket documentation

### System Architecture
- **[ARCHITECTURE.md](./docs/ARCHITECTURE.md)** - ⭐ Complete system architecture and components
- **[PROJECT_DOCUMENTATION.md](./docs/PROJECT_DOCUMENTATION.md)** - Comprehensive project overview
- **[HIERARCHICAL_SYSTEM.md](./docs/HIERARCHICAL_SYSTEM.md)** - Multi-agent system implementation
### Features & Fixes
- **[FEATURE_LOG_REST.md](./docs/FEATURE_LOG_REST.md)** - Rest day logging feature
- **[FEATURE_RESET_FATIGUE.md](./docs/FEATURE_RESET_FATIGUE.md)** - Fatigue reset feature
- **[BUG_FIX_SWITCH_USER.md](./docs/BUG_FIX_SWITCH_USER.md)** - Switch user bug fix
- **[FIX_FATIGUE_AND_RESET_WORKOUTS.md](./docs/FIX_FATIGUE_AND_RESET_WORKOUTS.md)** - Fatigue and workout reset fixes

### Setup & Testing
- **[TESTING.md](./docs/TESTING.md)** - Testing guide and troubleshooting
- **[GEMINI_SETUP.md](./docs/GEMINI_SETUP.md)** - Gemini API setup instructions
- **[FITNESS_RAG_SPEC.md](./docs/FITNESS_RAG_SPEC.md)** - Original technical specification
- **[PITCH_DECK.md](./docs/PITCH_DECK.md)** - 🎯 Pitch deck for non-technical audiences

## API Reference

Base URL: `http://localhost:8000`

### Health Check

```bash
curl http://localhost:8000/health
# → {"status": "healthy"}
```

---

### Onboarding a New User (Step-by-Step)

The onboarding flow creates a user profile, runs the AI persona recommender, and finalizes the user's training setup. Follow these steps in order:

#### Step 1: Intake — Submit profile and trigger persona recommendation

```bash
curl -X POST http://localhost:8000/api/users/user123/intake \
  -H "Content-Type: application/json" \
  -d '{
    "fitness_level": "Intermediate",
    "about_me": "I train at home, want to lose fat and build muscle. I have 30 minutes per day.",
    "equipment": ["dumbbells", "pull-up bar", "resistance bands"],
    "height_cm": 178,
    "weight_kg": 82
  }'
```

Response:
```json
{
  "status": "ok",
  "recommendation_pending": true,
  "recommended_personas": ["iron", "hiit"],
  "subscribed_personas": ["iron", "hiit"],
  "rationale": "Based on your fat loss and muscle building goals with limited time, Iron for strength and Inferno HIIT for metabolic conditioning are ideal...",
  "workout_duration_minutes": 30,
  "equipment": ["dumbbells", "pull-up bar", "resistance bands"]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fitness_level` | string | No | `"Beginner"`, `"Intermediate"`, or `"Advanced"` (default: `"Intermediate"`) |
| `about_me` | string | No | Free-text context about lifestyle, goals, limitations |
| `equipment` | string[] | No | Equipment available (e.g. `["dumbbells", "barbell", "yoga mat"]`) |
| `height_cm` | float | No | Height in centimeters |
| `weight_kg` | float | No | Weight in kilograms |

#### Step 2 (Optional): Refine — Adjust the recommendation with feedback

If the user doesn't like the recommendation, they can provide feedback to re-run the recommender:

```bash
curl -X POST http://localhost:8000/api/users/user123/refine-recommendation \
  -H "Content-Type: application/json" \
  -d '{"feedback": "I also want yoga for recovery days"}'
```

Response:
```json
{
  "recommended_personas": ["iron", "yoga"],
  "subscribed_personas": ["iron", "yoga"],
  "rationale": "Updated recommendation incorporating yoga for active recovery...",
  "recommendation_pending": true,
  "workout_duration_minutes": 30
}
```

This step can be repeated multiple times until the user is satisfied.

#### Step 3: Accept — Finalize onboarding

```bash
curl -X POST http://localhost:8000/api/users/user123/accept-recommendation
```

Response:
```json
{
  "status": "ok",
  "is_onboarded": true,
  "selected_persona": "iron",
  "subscribed_personas": ["iron", "yoga"],
  "recommended_personas": ["iron", "yoga"],
  "rationale": "...",
  "equipment": ["dumbbells", "pull-up bar", "resistance bands"],
  "workout_duration_minutes": 30
}
```

After this, the user is fully onboarded and can generate workouts.

#### Step 4 (Optional): Manual persona selection

If you want to override personas instead of using the recommender flow:

```bash
curl -X POST http://localhost:8000/api/users/user123/select-persona \
  -H "Content-Type: application/json" \
  -d '{"personas": ["iron", "hiit", "kickboxing"]}'
```

#### Alternative: Legacy onboard (biometrics only, no about_me)

```bash
curl -X POST http://localhost:8000/api/users/user123/onboard \
  -H "Content-Type: application/json" \
  -d '{
    "height_cm": 178,
    "weight_kg": 82,
    "goal": "Build muscle and lose fat",
    "fitness_level": "Intermediate"
  }'
```

---

### User Profile & Settings

#### Get profile

```bash
curl http://localhost:8000/api/users/user123/profile
```

Response:
```json
{
  "user_id": "user123",
  "height_cm": 178,
  "weight_kg": 82,
  "fitness_level": "Intermediate",
  "is_onboarded": true,
  "selected_persona": "iron",
  "subscribed_personas": ["iron", "yoga"],
  "recommended_personas": ["iron", "yoga"],
  "recommendation_rationale": "...",
  "about_me": "I train at home...",
  "equipment": ["dumbbells", "pull-up bar", "resistance bands"],
  "workout_duration_minutes": 30
}
```

#### Update settings

```bash
curl -X PATCH http://localhost:8000/api/users/user123/settings \
  -H "Content-Type: application/json" \
  -d '{
    "max_workouts_per_week": 5,
    "fatigue_threshold": 0.85,
    "equipment": ["dumbbells", "barbell", "bench"],
    "workout_duration_minutes": 45,
    "about_me": "Updated: now training at a gym"
  }'
```

All fields are optional — only include what you want to change.

#### Get weekly status

```bash
curl http://localhost:8000/api/users/user123/status
```

Response:
```json
{
  "workouts_completed_this_week": 2,
  "max_workouts_per_week": 5,
  "fatigue_scores": {"legs": 0.4, "push": 0.3, "pull": 0.2, "cardio": 0.1},
  "fatigue_threshold": 0.85,
  "selected_persona": "iron",
  "subscribed_personas": ["iron", "yoga"]
}
```

---

### Workout Flow (REST)

#### 1. Generate a workout

```bash
curl -X POST http://localhost:8000/api/users/user123/workout \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Give me a leg day workout"}'
```

The supervisor automatically picks the best worker from your subscribed personas based on your message. The workout is constrained to your equipment and duration settings.

#### 2. Log sets (while workout is active)

```bash
curl -X POST http://localhost:8000/api/users/user123/log-set \
  -H "Content-Type: application/json" \
  -d '{"exercise_id": "ex_abc123", "weight": 100, "reps": 8, "rpe": 7}'
```

You can also match by name: `{"exercise": "Barbell Squat", "weight": 100, "reps": 8, "rpe": 7}`

#### 3. Finish the workout

```bash
curl -X POST http://localhost:8000/api/users/user123/finish-workout
```

This applies RPE-based fatigue, increments the weekly counter, and saves the session to history.

#### Get workout history

```bash
curl http://localhost:8000/api/users/user123/history
```

---

### Fatigue & Weekly Resets (REST)

```bash
# Reset all fatigue scores to 0
curl -X POST http://localhost:8000/api/users/user123/reset-fatigue

# Reset weekly workout counter to 0
curl -X POST http://localhost:8000/api/users/user123/reset-workouts

# Simulate a new week (triggers decay on next workout)
curl -X POST http://localhost:8000/api/users/user123/new-week
```

---

### WebSocket: `/ws/workout/{user_id}`

The WebSocket provides real-time interaction for workout sessions and chat. Connect to:

```
ws://localhost:8000/ws/workout/{user_id}
```

On connect, the server sends the current state:
```json
{"type": "AGENT_RESPONSE", "state": {...}, "workout": null, "is_working_out": false}
```

#### Client Messages (send to server)

| Type | Payload | Description |
|------|---------|-------------|
| `USER_INPUT` | `{"type":"USER_INPUT", "content":"Give me a leg workout"}` | Generate a workout (supervisor routes to best worker) |
| `CHAT_MESSAGE` | `{"type":"CHAT_MESSAGE", "content":"How are my legs doing?"}` | Q&A or command (no workout generated) |
| `LOG_SET` | `{"type":"LOG_SET", "data":{"exercise_id":"ex_abc","weight":100,"reps":8,"rpe":7}}` | Log a set during active workout |
| `FINISH_WORKOUT` | `{"type":"FINISH_WORKOUT"}` | Finalize workout, apply fatigue |
| `LOG_REST` | `{"type":"LOG_REST"}` | Log a rest day (reduces fatigue by 30%) |
| `RESET_FATIGUE` | `{"type":"RESET_FATIGUE"}` | Reset all fatigue scores |
| `RESET_WORKOUTS` | `{"type":"RESET_WORKOUTS"}` | Reset weekly workout counter |
| `RESET_USER` | `{"type":"RESET_USER"}` | Delete all user data and start fresh |
| `RESUME` | `{"type":"RESUME"}` | Resume graph after interruption |
| `APPROVE_SUGGESTION` | `{"type":"APPROVE_SUGGESTION", "approved":true}` | Approve/reject agent suggestion |
| `REFINE_RECOMMENDATION` | `{"type":"REFINE_RECOMMENDATION", "feedback":"I also want yoga"}` | Re-run recommender with feedback |
| `ACCEPT_RECOMMENDATION` | `{"type":"ACCEPT_RECOMMENDATION"}` | Accept persona recommendation |

#### Server Messages (received from server)

| Type | Description |
|------|-------------|
| `AGENT_RESPONSE` | Workout state update: `{state, workout, is_working_out, chat_response?, greeting_message?}` |
| `CHAT_RESPONSE` | Q&A or command result: `{answer, state}` |
| `RECOMMENDATION_UPDATE` | Updated persona recommendation after refine |
| `RECOMMENDATION_ACCEPTED` | Confirmation after accepting recommendation |
| `ERROR` | Error message: `{message}` |

---

### Chat as Command Hub

The chat interface (`CHAT_MESSAGE` via WebSocket, or the QA agent) doubles as a command hub. Users can manage their settings through natural language:

| Say this... | What happens |
|-------------|-------------|
| "Reset my fatigue" | All fatigue scores set to 0 |
| "Reset workouts" / "Start fresh this week" | Weekly counter set to 0 |
| "Increase workouts to 5" | `max_workouts_per_week` updated to 5 |
| "I only have 20 minutes today" | `workout_duration_minutes` updated to 20 |
| "I just got a barbell and a bench" | `equipment` list updated |
| "Set fatigue threshold to 0.9" | `fatigue_threshold` updated to 0.9 |

Example via WebSocket:
```json
{"type": "CHAT_MESSAGE", "content": "I just got a barbell and a bench"}
```

Response:
```json
{
  "type": "CHAT_RESPONSE",
  "answer": "Done! I've updated your equipment list to include a barbell and bench.",
  "state": {"equipment": ["barbell", "bench"], "...": "..."}
}
```

Pure questions (no state change) also work:
```json
{"type": "CHAT_MESSAGE", "content": "How are my legs doing?"}
```

---

### Complete Example: Onboard + Workout + Chat

```bash
# 1. Onboard
curl -X POST http://localhost:8000/api/users/alice/intake \
  -H "Content-Type: application/json" \
  -d '{
    "fitness_level": "Beginner",
    "about_me": "New to fitness, want to get stronger",
    "equipment": ["dumbbells", "yoga mat"]
  }'

# 2. Accept the AI recommendation
curl -X POST http://localhost:8000/api/users/alice/accept-recommendation

# 3. Check profile
curl http://localhost:8000/api/users/alice/profile

# 4. Generate a workout (REST)
curl -X POST http://localhost:8000/api/users/alice/workout \
  -H "Content-Type: application/json" \
  -d '{"prompt": "I want a full body workout"}'

# 5. Log a set
curl -X POST http://localhost:8000/api/users/alice/log-set \
  -H "Content-Type: application/json" \
  -d '{"exercise": "Dumbbell Squat", "weight": 25, "reps": 10, "rpe": 6}'

# 6. Finish
curl -X POST http://localhost:8000/api/users/alice/finish-workout

# 7. Check status after workout
curl http://localhost:8000/api/users/alice/status
```

For real-time interaction (chat + workouts), use the WebSocket at `ws://localhost:8000/ws/workout/alice`.

## Database Management

View and manage users in the database:

```bash
# List all users
python main.py db list

# View user state
python main.py db view <user_id>

# Update fatigue scores
python main.py db update-fatigue <user_id> "legs:0.5,push:0.3"

# Reset workouts counter
python main.py db new-week <user_id>

# Or use the simple script
python view_users.py
python view_users.py <user_id>  # View specific user
```

See **[VIEW_USERS.md](./docs/VIEW_USERS.md)** for all database commands.

