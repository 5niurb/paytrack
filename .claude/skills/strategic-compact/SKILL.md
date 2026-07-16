---
name: strategic-compact
description: Suggests manual /compact at logical workflow intervals. Includes a hook that counts tool calls and reminds at thresholds.
---

# Strategic Compact

Suggests manual `/compact` at strategic points rather than relying on arbitrary auto-compaction.

## When to Activate

- Long sessions approaching context limits
- Multi-phase tasks (research → plan → implement → test)
- Switching between unrelated tasks
- After completing a major milestone
- When responses slow down or become less coherent

## Compaction Decision Guide

| Phase Transition | Compact? | Why |
|---|---|---|
| Research → Planning | **Yes** | Research context is bulky; plan is the distilled output |
| Planning → Implementation | **Yes** | Plan is in TodoWrite or a file; free up context for code |
| Implementation → Testing | Maybe | Keep if tests reference recent code |
| Debugging → Next feature | **Yes** | Debug traces pollute context for unrelated work |
| Mid-implementation | **No** | Losing variable names, file paths, partial state is costly |
| After a failed approach | **Yes** | Clear dead-end reasoning before trying new approach |

## What Survives Compaction

| Persists | Lost |
|---|---|
| CLAUDE.md instructions | Intermediate reasoning |
| TodoWrite task list | File contents you previously read |
| Memory files | Multi-step conversation context |
| Git state | Tool call history |
| Files on disk | Nuanced verbal preferences |

## Hook Setup

The `suggest-compact.mjs` script runs on PreToolUse (Edit/Write) and:
1. Reads recent observations from `observations.jsonl` (written by the observe hook)
2. Detects workflow phase from tool patterns: research, implementation, testing, debugging, exploration
3. Suggests /compact at **phase transitions** (research→implementation, debugging→next feature, etc.)
4. Detects **context bloat** from long read/search streaks (25+ consecutive reads without an edit)
5. Falls back to count-based milestones (50 calls, then every 25)

### Phase Detection
The script analyzes the last 20 tool calls to classify the current phase:
- **research**: 70%+ reads/greps/searches, few edits
- **implementation**: 6+ edits in last 20 calls
- **testing**: 8+ bash calls (running tests, builds, curls)
- **debugging**: errors detected + mix of reads and bash
- **exploration**: 3+ subagent Task calls

### Dependency
Requires the `observe.mjs` hook (continuous-learning-v2) to be active — it writes the observations
that suggest-compact reads for phase detection. Without it, falls back to count-only mode.

## Best Practices

1. **Compact after planning** — Plan finalized in TodoWrite? Compact and start fresh
2. **Compact after debugging** — Root cause found and fixed? Clear the debug context
3. **Don't compact mid-implementation** — Preserve context for related changes
4. **Write before compacting** — Save important context to files or SESSION_NOTES.md
5. **Use /compact with a summary** — `/compact Focus on implementing auth middleware next`
