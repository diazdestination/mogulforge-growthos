# MogulForge — Beta Launch Runbook

GrowthOS production already runs as Fly app `mogulforge-growthos` at
`https://app.mogulforge.ai`. The founding-owner slot has been claimed.

Production registration is now fail-closed: a new company owner must be listed
in `BETA_SIGNUP_ALLOWLIST`. Teammates pre-provisioned through the in-app invite
flow can complete registration without being allowlisted. This gives beta users
separate accounts and organizations without adding a paid identity provider.

Use [STAGING.md](STAGING.md) for the isolated pre-production environment.

---

## Controlled production release

Run commands from the canonical private repository:
`C:\Users\diazd\dev\projects\mogulforge`.

1. Confirm the draft PR's tests, TypeScript checks, and production builds pass at
   the exact commit being released.
2. Test the same commit in the isolated staging app.
3. Set production's `BETA_SIGNUP_ALLOWLIST` to the lowercase email addresses of
   approved new-company owners. Do not put invited teammates in this list.
4. Confirm the production secret names with `fly secrets list --app
   mogulforge-growthos`; never print secret values.
5. Deploy with both identities explicit:

```powershell
fly deploy --app mogulforge-growthos --config fly.toml
```

6. Verify cold-start health, login, blocked unknown signup, one allowlisted owner,
   one invited teammate, and tenant isolation before sending beta invitations.

Never use a bare `fly deploy`, and never merge or deploy a commit whose CI run
belongs to an earlier branch head.

---

## Fly dashboard / GitHub launcher warning

Do not use **Launch from GitHub** for routine releases. That path can regenerate
configuration, drop the repository's release command, select the wrong origin,
or create another billable app. The canonical production and staging configs are
already committed.

If the dashboard launcher is ever required for disaster recovery, verify the app
name, `APP_ORIGIN`, Dockerfile, database attachment, `min_machines_running`,
and migration strategy before deploying. `AUTO_MIGRATE=true` is an emergency
guard for a launcher that drops `[deploy].release_command`; it is not the normal
production migration path.

---

## Windows / PowerShell notes (Diego's machine, verified 2026-08-06)

`flyctl` v0.4.79 is installed at `C:\Users\diazd\.fly\bin\` and is on the persistent
User PATH. The installer's `fly` symlink step needs admin and was skipped, so a
`fly.cmd` shim was added next to it — **both `fly` and `flyctl` work**, no elevation.

Step 4 above is bash. In PowerShell, `$(node -e "...")` does NOT interpolate — you'd
set the literal string as your secret and every session cookie would break. Use:

```powershell
$secret = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
fly secrets set SESSION_SECRET=$secret
```

Everything else in the Fly sequence works unchanged in PowerShell.

### Custom domain on Cloudflare (mogulforge.ai)

`mogulforge.ai` uses Cloudflare nameservers (`newt`/`roxy.ns.cloudflare.com`).
Cloudflare is **DNS/CDN only** — it does not run this container (Workers are V8
isolates, not Node; D1 is SQLite, not Postgres). So Fly (or any container host)
runs the app and Cloudflare points at it. Plan: keep the marketing site on the
root domain, put the CRM on **`app.mogulforge.ai`** (confirmed unused).

```bash
fly certs add app.mogulforge.ai      # then add the record it prints, in Cloudflare
```

⚠️ Set that DNS record to **DNS-only (grey cloud)** until the cert is issued —
Cloudflare's proxy (orange cloud) breaks Fly's ACME validation. After it's live you
can enable the proxy with SSL mode **Full (strict)**.

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
- [ ] `BETA_SIGNUP_ALLOWLIST` contains only approved new-company owner emails
- [ ] Unknown public signup returns `BETA_INVITE_REQUIRED`
- [ ] Invited teammates can register without being added to the allowlist
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

1. An approved new-company owner is added to `BETA_SIGNUP_ALLOWLIST`.
2. They visit the URL, create an account, and create their own company workspace.
3. Their organization receives neutral defaults, automations, and a starter playbook.
4. They invite teammates from GrowthOS; those teammates register directly into
   the correct organization without needing allowlist entries.
5. Every user can correct their own display name from **My Profile**, while role
   and status remain administrator-controlled.
6. Each organization is isolated from every other beta customer's data.

## Operating the beta (you, as platform admin)

- `/platform` — see every org + member counts.
- Deactivate a user → they're signed out within ~30s (AccessGate).
- Watch logs: `fly logs` (Fly) or `docker compose logs -f app` (VPS).
