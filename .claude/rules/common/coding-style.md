# Coding Style

## Project-Specific Conventions

Each project has its own tech stack — respect it:
- **lemedspa-website**: Vanilla HTML/CSS/JS. No frameworks, no build tools.
- **paytrack**: Express + Supabase. No ORM, direct Supabase client calls.
- **lm-app**: SvelteKit + shadcn-svelte + Tailwind v4 (frontend), Express (API), Supabase (database).

Prefer vanilla JS over adding dependencies. Keep things simple.

## File Organization

Prefer many small files over few large files:
- High cohesion, low coupling
- 200-400 lines typical, 800 max
- Extract utilities from large modules
- Organize by feature/domain, not by type

## Error Handling

Handle errors explicitly:
- Provide user-friendly messages in UI-facing code
- Log detailed context on the server side
- Never silently swallow errors
- Fail fast with clear messages

## Input Validation

Validate at system boundaries:
- All user input before processing
- External API responses before trusting
- Use schema-based validation where available (Supabase RLS, Zod, etc.)

## Avoid Over-Engineering

- Don't add features beyond what was asked
- Don't create helpers/abstractions for one-time operations
- Don't add error handling for scenarios that can't happen
- Three similar lines is better than a premature abstraction
- A bug fix doesn't need surrounding code cleaned up

## Code Quality Checklist

Before marking work complete:
- [ ] Code is readable and well-named
- [ ] Functions are small (<50 lines)
- [ ] Files are focused (<800 lines)
- [ ] No deep nesting (>4 levels)
- [ ] Proper error handling at boundaries
- [ ] No hardcoded secrets (use env vars)
- [ ] Accessibility considered (alt text, ARIA, keyboard nav)
