# Per-User Persistence & History-Based Fatigue

## 1. Objective
Enable persistent state tracking using SQLite so that each user's fatigue scores and workout history are preserved across sessions. Implement a logic layer that adjusts starting fatigue based on the intensity and volume of the "previous day's workout."

## 2. Technical Requirements

### Database
- **Technology**: `langgraph.checkpoint.sqlite.SqliteSaver` for state persistence
- **Location**: `checkpoints/checkpoints.db` (created automatically)
- **Thread-based**: Each `user_id` maps to a unique `thread_id` for isolation

### State Schema
The `FitnessState` includes:
- `workout_history: List[Dict]` - Stores previous workout JSONs
- `fatigue_scores: Dict[str, float]` - Current fatigue levels
- `last_session_timestamp: float` - Last session time for decay calculation

### Workflow
1. **Supervisor Node** - Entry point, processes user requests
2. **Decay Node** - Applies time-based fatigue decay
3. **History Analysis Node** - Applies fatigue based on previous workout
4. **Worker Nodes** - Generate workouts and save to history

## 3. Implementation Details

### History Analysis Logic
The `history_analysis_node` analyzes the most recent workout in `workout_history` and applies fatigue penalties:

- **Strength Training**: 
  - Legs focus → +0.3 to `legs` fatigue
  - Push focus → +0.3 to `push` fatigue
  - Pull focus → +0.3 to `pull` fatigue

- **Yoga/Mobility**:
  - Spine focus → +0.25 to `spine` fatigue
  - Hips focus → +0.25 to `hips` fatigue
  - Shoulders focus → +0.25 to `shoulders` fatigue

- **HIIT/Cardio**:
  - Cardio focus → +0.4 to `cardio`, +0.3 to `cns` fatigue

- **Kickboxing**:
  - Coordination/Speed/Endurance → +0.3 to respective attributes

- **Exercise-level analysis**: Additional fatigue based on exercise names (e.g., "squat" → +0.2 legs)

All fatigue values are capped at 1.0.

### Persistence Setup
```python
from graph import run_workout

# Each user_id gets their own thread_id for state isolation
result = run_workout(
    user_id="aashish_ravindran",  # This becomes the thread_id
    persona="iron",
    goal="Build strength",
    fatigue_scores={"legs": 0.3, "push": 0.2},
    messages=[{"role": "user", "content": "I want a workout"}],
)
```

### State Loading
When `run_workout` is called with an existing `user_id`:
1. LangGraph's checkpointer automatically loads previous state
2. `workout_history` is restored
3. `fatigue_scores` are restored (after decay is applied)
4. New workout is generated based on historical context

### Workout History Storage
Each worker node automatically appends the generated workout to `workout_history`:
- Workout is saved as JSON-compatible dict
- History persists across sessions
- Only the most recent workout is analyzed for fatigue penalties

## 4. File Structure

```
agents/
  ├── history_analyzer.py  # History analysis node
  ├── workers.py            # Updated to save workouts to history
graph.py                    # Updated with SqliteSaver and history_analysis node
state.py                    # Updated with workout_history field
checkpoints/
  └── checkpoints.db        # SQLite database (auto-created)
```

## 5. Usage Example

```python
# First session - no history
result1 = run_workout(
    user_id="user123",
    persona="iron",
    goal="Build strength",
    fatigue_scores={"legs": 0.1, "push": 0.1},
)

# Second session (next day) - history is loaded
# History analysis will add fatigue based on previous workout
result2 = run_workout(
    user_id="user123",  # Same user_id = same thread_id
    persona="iron",
    goal="Build strength",
    fatigue_scores={"legs": 0.1, "push": 0.1},  # Base fatigue
    # History analysis will add +0.3 to legs if previous workout targeted legs
)
```

## 6. Requirements

- `langgraph-checkpoint-sqlite>=2.0.0` must be installed
- `checkpoints/` directory will be created automatically
- Each `user_id` should be consistent across sessions for proper state tracking

## 7. Future Enhancements

- More granular fatigue calculation based on sets/reps/volume
- Multi-day fatigue accumulation patterns
- Recovery recommendations based on history
- Workout periodization based on historical patterns
