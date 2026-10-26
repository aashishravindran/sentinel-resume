# steal-my-agents

A collection of Claude Code custom agents worth stealing. Each agent is a single `.md` file with YAML frontmatter that Claude Code loads automatically — giving you specialized sub-agents that handle specific workflows so your main conversation stays clean and focused.

## Agents

| Name | Description |
|------|-------------|
| `project-wrapup` | End-of-session agent that updates documentation, commits changes with a conventional commit message, pushes to remote, and delivers a clean wrap-up summary. Invoke it when you're done with a work session. |

## Install

```bash
git clone https://github.com/raashish1601/steal-my-agents.git
cd steal-my-agents
bash install.sh
```

The installer will ask where to install:

- **Global** (`~/.claude/agents/`) — agents available in every project
- **Local** (`./.claude/agents/`) — agents available only in the current directory

You can pick individual agents or install all of them at once. Re-running the installer is safe — identical agents are skipped automatically.

## How Claude Code agents work

Agents are `.md` files with a YAML frontmatter block:

```yaml
---
name: my-agent
description: "What this agent does and when to invoke it."
model: sonnet   # opus | sonnet | haiku
color: purple
---

Your agent instructions here...
```

Claude Code loads agents from:
- `~/.claude/agents/` (global, all projects)
- `.claude/agents/` (project-local, current project only)

Once loaded, you can invoke an agent by asking Claude to use it, or agents can be launched automatically by the main assistant via the Agent tool when the task matches the agent's description.

For full documentation see the [Claude Code agents docs](https://docs.anthropic.com/en/docs/claude-code/sub-agents).

## Contributing

To add a new agent:

1. Create `agents/your-agent-name.md` with this frontmatter:

```yaml
---
name: your-agent-name
description: "One paragraph explaining what this agent does and when to invoke it."
model: sonnet
color: blue
---

Agent instructions...
```

2. Add a row to the agents table in this README.
3. Open a PR.

**Guidelines:**
- Each agent should do one thing well.
- The `description` field is critical — Claude uses it to decide when to invoke your agent automatically. Be specific about the trigger condition.
- Instructions should be self-contained; don't assume the agent has project-specific context.
