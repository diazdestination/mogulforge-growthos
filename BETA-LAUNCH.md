# MogulForge — Beta Launch Runbook

Goal: a public HTTPS URL where beta users sign up and each gets their own CRM.
The app is already **multi-tenant**: the **first account = you** (platform owner
+ admin, can see every org at `/platform`); every later signup creates **their
own** organization via the self-serve flow. That's the SaaS beta shape — no code
changes needed to onboard beta customers.

---

## Fastest path — Fly.io (deploys from your machine, no git repo)

Prereqs: a Fly.io account + `flyctl` installed (`https://fly.io/docs/flyctl/install/`).
Run all commands from the repo root (`C:\Users\diazd\dev\projects\mogulforge`).

```bash
# 1. Log in
fly auth login

# 2. Create the app from fly.toml (edit `app = ` to a unique name first)
fly launch --no-deploy --copy-config

# 3. Managed Postgres, attached (this sets the DATABASE_URL secret automatically)
fly postgres create --name mogulforge-db
fly postgres attach mogulforge-db

# 4. Session secret (stable — changing it logs everyone out)
fly secrets set SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

# 5. Deploy. The release_command in fly.toml pushes the DB schema automatically.
fly deploy

# 6. Open it
fly open
```

Then on the live URL: **Create account** → you're the owner. Share the URL with
beta users; they each **Create account** → their own org.

> If `fly postgres create` isn't available on your plan, use any managed Postgres
> (Neon, Supabase, RDS) and set `fly secrets set DATABASE_URL=postgres://...`.

---

## Alternative — any VPS with Docker (self-host)

```bash
# on the server, in the repo:
cp .env.example .env         # set a real SESSION_SECRET
docker compose up -d db
docker compose run --rm app sh -lc \
  "cd /app && pnpm --filter @workspace/db exec drizzle-kit push --force"
docker compose up -d --build app
# app is on :8080 — put a TLS reverse proxy (Caddy/nginx/Cloudflare) in front for HTTPS
```

HTTPS is required in production (the session cookie is `Secure`). Caddy is the
one-liner option: it auto-provisions Let's Encrypt certs for your domain.

---

## Custom domain

- **Fly:** `fly certs add app.yourdomain.com`, then add the shown DNS records.
- **VPS:** point an A record at the server; let Caddy/your proxy issue the cert.

---

## Go-live checklist

- [ ] `SESSION_SECRET` set and **stable** (never rotate casually — logs everyone out)
- [ ] `DATABASE_URL` points at managed Postgres with **automated backups on**
- [ ] `ENABLE_DEV_LOGIN` is **unset** in prod (the no-password backdoor stays off)
- [ ] HTTPS working (green lock); test **Create account → dashboard**
- [ ] You created your owner account first (so you're platform admin at `/platform`)
- [ ] Rebrand values reviewed in the two `client.config.ts` (name/color/phone)
- [ ] (Optional) invite-only: keep the URL private + share directly, or add a
      signup allowlist later
- [ ] (When charging) add Stripe keys — see "Paid plans" below

---

## Paid plans (Stripe) — when you're ready

Billing ships **off** so the beta is free and frictionless. To turn it on later,
set these secrets (Fly: `fly secrets set ...`; VPS: add to `.env`) and redeploy:

```
STRIPE_SECRET_KEY=sk_live_...      # or sk_test_... to trial it
STRIPE_PRICE_ID=price_...          # the recurring price customers subscribe to
STRIPE_WEBHOOK_SECRET=whsec_...    # from the Stripe dashboard webhook → /api/billing/webhook
# BILLING_ENFORCE=true             # ONLY when you want to actually gate non-subscribers
```

The **Billing** page (admin nav) then shows the plan + a "Start subscription
(14-day trial)" button (Stripe Checkout) and a "Manage billing" portal. Point the
Stripe webhook at `https://<your-domain>/api/billing/webhook`. Leave
`BILLING_ENFORCE` unset to keep access open while you onboard.

## Demo data

New orgs land on an empty dashboard with a **"Load sample data"** button (admins)
that seeds 10 sample leads across the full pipeline — great for demos and for beta
users kicking the tires. It's clearable anytime (nothing but the sample rows).

---

## What beta users experience

1. Visit the URL → **Create account** (email + password).
2. They're not in your org, so they hit **Create your company** (self-serve org).
3. Their org seeds neutral defaults (settings, automations, a starter playbook).
4. They land in their own CRM: pipeline, contacts, tasks, appointments, capture
   widget, AI concierge, reports — fully isolated from other tenants.

## Operating the beta (you, as platform admin)

- `/platform` — see every org + member counts.
- Deactivate a user → they're signed out within ~30s (AccessGate).
- Watch logs: `fly logs` (Fly) or `docker compose logs -f app` (VPS).
