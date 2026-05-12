# Security Guidelines

## Pre-Commit Checklist

Before any commit:
- [ ] No hardcoded secrets (API keys, passwords, tokens)
- [ ] All user inputs validated at boundaries
- [ ] SQL injection prevention (parameterized queries / Supabase RLS)
- [ ] XSS prevention (sanitized HTML output)
- [ ] Error messages don't leak sensitive data
- [ ] No `.env` files or credentials in staged changes

## Auto-Trigger Security Review

Spawn the `security-reviewer` agent automatically when touching:
- Authentication or authorization code
- Payment processing (Stripe)
- Patient/PII data handling
- API route definitions
- Session management

## Secret Management

- NEVER hardcode secrets in source code
- Use environment variables configured in platform dashboards (Cloudflare/Render/Supabase)
- The `.env` blocker hook prevents accidental edits to sensitive files
- No `.env` files are committed — env vars live in platform dashboards only

## Environment Variables by Project

| Project | Env Vars |
|---------|----------|
| paytrack | SUPABASE_URL, SUPABASE_ANON_KEY, PAYTRACK_ENCRYPTION_KEY, RESEND_API_KEY, ADMIN_PASSWORD, PORT |
| lm-app | SUPABASE_URL, SUPABASE_ANON_KEY, TWILIO creds, STRIPE keys, RESEND_API_KEY |
| lemedspa-website | CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID (deploy only) |

## Security Response Protocol

If a security issue is found:
1. STOP — don't continue with other work
2. Spawn `security-reviewer` agent for full analysis
3. Fix CRITICAL issues immediately
4. Rotate any exposed secrets
5. Check for similar patterns elsewhere in codebase
