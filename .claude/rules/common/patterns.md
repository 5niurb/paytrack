# Common Patterns

## Architectural Patterns

These patterns are used across the LM workspace:

### Directive-Based Execution
Markdown files define the "what" (intent), scripts handle the "how" (execution). Claude orchestrates between them. Examples: SKILL.md files, CLAUDE.md instructions.

### Parallel Subagent Map-Reduce
Split work into chunks, fan out to N subagents in background, merge results. Used by email-classifier for inbox triage.

### File-Based IPC for Subagents
Subagents read from input files and write to output files. Poll for file existence rather than using TaskOutput (avoids context pollution). Used by `/orchestrate` pipeline.

### Skills as Living Documents
SKILL.md files include "Learnings" sections that capture production-discovered edge cases. When something breaks, fix the script AND update the skill doc.

### Tool Whitelisting
Each skill/agent declares which tools it's allowed to use. The executor validates before running.

## API Response Format

For lm-app and paytrack APIs, use a consistent envelope:
- Include success/status indicator
- Include data payload (nullable on error)
- Include error message (nullable on success)
- Include metadata for paginated responses (total, page, limit)

## Repository Pattern (lm-app)

For Supabase data access:
- Standard operations: findAll, findById, create, update, delete
- Business logic depends on abstract interface, not storage details
- Direct Supabase client calls (no ORM) — but keep them organized

## Portable Config

All Claude Code config is committed to git repos — clone and go:
- `.claude/settings.json` — hooks using `$CLAUDE_PROJECT_DIR` paths
- `.claude/agents/` — project-specific agents
- `.claude/skills/` — project-specific skills
- `.claude/scripts/` — hook scripts (session-memory, ci-check, etc.)
