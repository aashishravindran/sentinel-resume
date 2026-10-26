# SuperSetUI

Front end for the [Agentic Fitness App](https://github.com/aashishravindran/agentic-fitness-app), built from the [api-talker](https://github.com/aashishravindran/api-talker) UI and wired to the agentic-fitness-app backend.

## Features

- **Landing** – SuperSet branding and coach preview (Iron, Yoga, HIIT, Kickboxing)
- **Login** – Username-based login (stored in `localStorage`)
- **Onboarding** – Chat-style intake; calls `POST /api/users/{id}/intake` and `POST /api/users/{id}/select-persona`
- **Dashboard** – Max robot and “Trust Max” / “Follow my path” entry to workout
- **Workout** – WebSocket at `ws://localhost:8000/ws/workout/{user_id}`: send `USER_INPUT`, receive `AGENT_RESPONSE` with workout; **Finish workout** sends `FINISH_WORKOUT`
- **History** – `GET /api/users/{id}/history` → `workout_history` displayed with coach badges

## Setup

1. **Backend (agentic-fitness-app)**  
   Run the FastAPI server on port 8000 (see [agentic-fitness-app](https://github.com/aashishravindran/agentic-fitness-app) for Ollama, env, etc.):

   ```bash
   cd /path/to/agentic-fitness-app
   python -m uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
   ```

2. **Frontend (this repo)**

   ```bash
   cd /Users/raashish/Documents/SuperSetUI
   npm install
   npm run dev
   ```

   Open **http://localhost:5173**.

3. **Optional – different API origin**  
   Set `VITE_API_BASE_URL` (e.g. `http://localhost:8000`) in `.env` or when building. Default is `http://localhost:8000`.

## Tech stack

- Vite + React 18 + TypeScript
- React Router, Framer Motion, Tailwind CSS, Radix (button/slot), Sonner toasts
- WebSocket and REST wired to agentic-fitness-app (onboard/intake, select-persona, status, history, `/ws/workout/{user_id}`)

## API wiring summary

| UI action           | Backend (agentic-fitness-app)                          |
|---------------------|--------------------------------------------------------|
| Login               | Local only (`localStorage`)                            |
| Onboarding complete | `POST /api/users/{id}/intake`, then `POST .../select-persona` |
| Workout chat        | `WS /ws/workout/{id}` → `USER_INPUT` → `AGENT_RESPONSE`|
| Finish workout      | `FINISH_WORKOUT` over same WebSocket                   |
| History             | `GET /api/users/{id}/history` → `workout_history`      |
