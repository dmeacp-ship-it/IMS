# Virgo ACP — Branch Transfer Tracker (IMS)

Node/Express web app for tracking branch-to-branch stock transfers, deployable
on Vercel. Backed by Supabase (source of truth); the Google Sheet + bound Apps
Script (Part A) still feeds `sales_transactions` — that half is unchanged.

This project is the **Node port** of what used to be a Google Apps Script Web
App. The original 3-file Apps Script version is preserved under
[`gas-legacy/`](gas-legacy/) for reference.

## Architecture

- **`api/index.js`** — a single Express app, run as one Vercel serverless
  function. All routes are under `/api/*`.
- **`lib/auth.js`** — SHA-256 password check, JWT session issuing/verification,
  `requireRole` middleware, best-effort login rate limiting.
- **`lib/data.js`** — all Supabase data access (branch/admin/HOD dashboards,
  mark-received, user management, destination tagging).
- **`lib/supabase.js`** — the `@supabase/supabase-js` client using the
  **service_role** key (server-side only; bypasses RLS by design — GAS-era note
  still holds: authorization is enforced in code, not RLS).
- **`public/`** — the static single-page frontend (`index.html`, `styles.css`,
  `app.js`). Served at `/`; talks to the API via `fetch`.

### Sessions
Sessions are **stateless JWTs stored in an httpOnly cookie** (`ims_session`),
replacing the Apps Script `ScriptProperties` store — which doesn't exist on
serverless. TTL is 8 hours. The browser never sees or manages a token; requests
just send the cookie (same-origin). Log in → cookie set; log out → cookie
cleared.

### Roles
`SUPER_ADMIN`, `ADMIN`, `BRANCH`, `HOD` — same rules as before. Role checks are
enforced server-side on every endpoint (`requireRole`), and `markReceived`
re-verifies branch ownership before flipping status.

## Environment variables

Set these locally in `.env` (copy from `.env.example`) and in the Vercel
project settings for production:

| Var | What |
|---|---|
| `SUPABASE_URL` | Supabase REST URL, e.g. `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Supabase **service_role** key (server-side only) |
| `SESSION_SECRET` | Random secret for signing session JWTs |

Generate a `SESSION_SECRET`:
```
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

## Local development

```
npm install
cp .env.example .env      # then fill in the three values
npm run dev               # http://localhost:3000
```

## Bootstrapping the first user

Before any UI exists to create accounts, create the first SUPER_ADMIN from the
CLI (uses the same SHA-256 hashing as the app, so the login will match):

```
npm run create-user -- <username> <password> "<full name>" SUPER_ADMIN
```

Then log in and create the rest (BRANCH/HOD/ADMIN) from the Admin UI.

## Deploy to Vercel

1. Push this folder to a Git repo (GitHub/GitLab/Bitbucket).
2. Import it in Vercel → it auto-detects the `api/` function and `public/`
   static assets (no build step needed).
3. In **Project Settings → Environment Variables**, add the three vars above.
4. Deploy. The app is served at your Vercel domain; the API lives under `/api`.

`vercel.json` rewrites all `/api/*` requests to the single Express function.

## Notes / trade-offs

- **Password hashing is SHA-256 (unsalted)** — kept identical to the Apps Script
  version so existing `password_hash` values in `user_profiles` still validate.
  If you'd rather move to a salted hash (bcrypt/argon2), it needs a migration
  that re-hashes on next login; not done here to avoid invalidating current
  logins.
- **Rate limiting is best-effort in-memory** — it only persists while a
  serverless instance stays warm, so lockout isn't guaranteed across cold starts
  or parallel instances. For hard guarantees, back it with Supabase or Upstash
  Redis (see `lib/auth.js`).
- No schema changes were needed — this port reuses the existing Supabase tables,
  views, trigger, and seed data as-is.
