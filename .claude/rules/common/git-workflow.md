# Git Workflow

## Commit Message Format

```
[area] Brief description of what changed

- Detail 1
- Detail 2

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

Examples:
- `[website] Add NuEra Tight to medical services`
- `[config] Update CLAUDE.md with git sync instructions`
- `[paytrack] Fix pay period calculation for biweekly`
- `[lm-app] Scaffold call logging API routes`

## Auto-Sync Rules

- **After each major milestone**, commit and push automatically
- **Stage specific files** — never use `git add -A` (avoid secrets/binaries)
- **Never force-push** to main/master
- **Never commit** `.env` files, secrets, or large binaries
- If push fails, `git pull --rebase` then push again
- At **end of every session**, ensure all work is committed and pushed

## When to Auto-Commit

- After completing a feature, fix, or content update
- After updating config files (CLAUDE.md, settings.json, etc.)
- After creating or modifying assets (SVG, images, CSS)
- Before ending a session (final checkpoint)

## Feature Implementation Workflow

1. **Plan** — Use `architect` agent for complex features
2. **Implement** — Small, incremental changes
3. **Review** — Spawn `code-reviewer` on changed files
4. **QA** — Spawn `qa` agent to generate and run tests
5. **Fix** — Address review/QA findings
6. **Ship** — Commit, push, deploy

Or use `/orchestrate feature <description>` for the full automated pipeline.

## Pull Requests

When creating PRs:
1. Analyze full commit history (`git diff [base]...HEAD`)
2. Keep title under 70 characters
3. Include summary bullets and test plan
4. Push with `-u` flag for new branches
