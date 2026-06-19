# Project C200 — Demo Portal Setup & State

**As of 2026-06-19.** This is the authoritative handoff for the Project C200 demo
environment. It captures what the project is, everything that was done to stand it
up, the current operational state, and how to run/continue it.

> Raw secrets (admin password, DB password, service-role key, access token) are **not**
> in this file. They live in the gitignored `.env` and `DEMO-CREDENTIALS.local.md`.

---

## 1. What this is

A **Spej-branded, client-agnostic demo** of an AI-assisted insurance claims
**Demand Packet Review Portal**. Adjusters review claim documents (demand letters,
medical records, bills); the pipeline extracts structured data and presents an AI
synthesis for human review.

Stack: **Vite + React + TypeScript + Tailwind/shadcn** front end over **Supabase**
(Postgres, Auth, Storage, Edge Functions).

### Origin & independence
- Copied from `github.com/SpejAI/supabase-claim-companion` (the "Nodak Claims
  Analyzer") into a **fresh, independent repo** — no shared git history, own remote
  `github.com/Sean-SpejAI/ProjectC200`.
- Repurposed away from Nodak/ImageRight into a generic Spej template (see §3).

---

## 2. Supabase backend

| | |
|---|---|
| Project ref | `fihahgtxitixjkoegunk` |
| API URL | `https://fihahgtxitixjkoegunk.supabase.co` |
| Region | `us-east-1` · name "sb@spej.ai's Project" (dashboard label "C200", env `main`/PRODUCTION) |
| Schema | All repo migrations applied via `supabase db push` |
| Storage bucket | `claim-documents` (private) |
| Dashboard | https://supabase.com/dashboard/project/fihahgtxitixjkoegunk |

### Admin DB access (important)
The **direct** `db.<ref>.supabase.co` host does **not resolve** for this project — use
the **session pooler**:
```
host=aws-1-us-east-1.pooler.supabase.com  port=5432  user=postgres.fihahgtxitixjkoegunk  db=postgres  ssl=require
```
- Migrations were pushed with `supabase db push --db-url "postgresql://postgres.fihahgtxitixjkoegunk:<DB_PW>@aws-1-us-east-1.pooler.supabase.com:5432/postgres"`.
- Ad-hoc admin SQL was run via Node `pg` (installed transiently with `npm install pg --no-save`) against that pooler. (`psql` is not installed locally.)

---

## 3. What was done (in order)

1. **Independent import** — copied source tree, dropped the source `.git`, fresh
   initial commit (`f63e964`).
2. **Genericize ImageRight → System of Record (SOR)** (`66fb35c`):
   - Renamed all identifiers `ImageRight→Sor`, `IMAGERIGHT→SOR`, `imageright→sor`,
     the `IR*` types → `Sor*`, the `source` enum value `'imageright'→'sor'`, and the
     `imageright_*` DB columns → `sor_*`. User-facing labels read "System of Record".
   - `git mv` of 6 edge-function dirs, 3 `_shared` modules, 2 components, 8 migrations.
   - **Severed the live connector**: deleted the `imageright-proxy/` app + all
     creds/hostnames. SOR ingestion functions remain but are **dormant** (inert
     without `SOR_PROXY_URL`/`SOR_PROXY_TOKEN`).
   - Added [`docs/SystemOfRecord-Connector-Contract.md`](SystemOfRecord-Connector-Contract.md)
     — the HTTP contract a future client's connector must satisfy.
   - Removed Nodak everywhere; deleted Nodak/ImageRight infra runbooks from `docs/`.
3. **Spej rebrand — dark theme + assets** (`99eaf27`):
   - Theme matches **spej.ai/ai-office**: navy `#1a2332`, teal `#4ecdc4`, white text.
     Tokens in [`src/index.css`](../src/index.css) `:root`.
   - Logo `public/logo.png` (white "spej" wordmark); favicon `public/favicon.svg`
     (navy square + teal lines) + `public/apple-icon.png`, wired in `index.html`.
4. **Disable mandatory MFA** (`797431a`): `MFA_ENFORCED = false` flag in
   [`src/components/ProtectedRoute.tsx`](../src/components/ProtectedRoute.tsx) gates both
   the enrollment + step-up screens. Safe — no `aal2` requirement in RLS. Flip to
   `true` to restore 2FA.
5. **Pre-login access gate** (`c54d230`): [`src/components/AccessGate.tsx`](../src/components/AccessGate.tsx)
   — a blur overlay over `/auth`; the login form is disabled until a hardcoded
   gate code is entered (sessionStorage-persisted). **Obfuscation only**, not real
   security (values ship in the bundle) — purpose: keep clients from casually
   stumbling on the demo.
6. **Title rename** (`63b3545`): "Spej Demand Packet Review Portal" →
   **"Project C200 Demo Portal"** (title, OG/Twitter, all headings, email templates).
7. **Admin login created** (DB, not in repo): `sb@spej.ai`, email confirmed, role
   `admin`. (New users otherwise hit a pending-approval gate until granted a role in
   `user_roles`; the first admin must be granted via SQL.)
8. **Restored 3-claim demo data** (see §5).
9. **Deployed all 21 edge functions** (see §6).

---

## 4. Current operational state

**ON:**
- Front end (local dev server), Postgres, Auth, Storage, all edge functions.
- **Document viewing** works: `sign-claim-document` mints signed URLs; PDFs download
  (`%PDF`, `application/pdf`) — verified end-to-end.

**OFF (intentional — this is a hardcoded-data demo):**
- **AI pipeline** — `analyze-claim-document` / `synthesize-claim-extraction` /
  `claims-chat` are deployed but need a Gemini/Vertex key (not set); they'll error if
  invoked. The restored claims already carry completed `ai_synthesis`, so the demo
  shows AI output without running AI.
- **Scheduled jobs** — **pg_cron is not installed** → zero schedules. The daily SOR
  sync, the 3 watchdogs, and the `analyze_stages` pgmq pump cannot auto-fire.
- **SOR ingestion** — `SOR_PROXY_URL`/`SOR_PROXY_TOKEN` unset and `sor_settings`
  empty, so claim-retrieval can't run even if triggered. Verified post-deploy:
  `sor_sync_runs = 0`, `sor_sync_tasks = 0`.

> **Do not enable pg_cron** unless you want the SOR sync + watchdogs to start firing.

---

## 5. Demo data (restored)

- **3 claims / 179 document rows / 174 PDFs** in `claim-documents`. All `file_url`s
  resolve to uploaded objects (174/174). `ai_synthesis` intact on all 3 claims.

| Claim # | Claimant | Docs |
|---|---|---|
| 0000312624 | DYE, DA SHIYA RA NAYE | 116 |
| 0000325507 | EVANSON, MICHAEL | 35 |
| 0000360689 | VALADEZ, MICHELLE | 28 |

### Restore mechanics (for re-running)
- Backup: `C:\Users\sean\ncp-backups\ncp-3claims-restore-2026-06-19.zip` (~904 MB).
  Extracted working copy: `C:\Users\sean\ncp-backups\restore-work\`.
- Bundle ships `restore.mjs` (dependency-free, Node 18+): ensures bucket → upserts
  `claims → claim_documents → claim_field_audit` via PostgREST → uploads PDFs to the
  manifest keys with `x-upsert`. Run with `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`.
- **CRITICAL gotcha**: the backup is from the **old** project `oopjlechxxbyisntbtvw`
  (Nodak Claims Analyzer Production), so its JSON rows carry `imageright_*` columns +
  `source:'imageright'`. Before restoring, the row JSON in `restore-work/data/` was
  **transformed** (`imageright_*`→`sor_*`, `source`→`'sor'`) to match this project's
  renamed schema. Storage keys/`file_url` keep their original `imageright/…`/`manual/…`
  paths (they're internally consistent — only DB column names needed changing).

---

## 6. Edge functions

All **21** deployed via `supabase functions deploy --project-ref fihahgtxitixjkoegunk`
(requires `SUPABASE_ACCESS_TOKEN`; bundles server-side, no Docker needed):
`sign-claim-document`, `sor-sync`, `fetch-sor-document`, `reload-claim-from-sor`,
`recover-empty-sor-docs`, `admin-inspect-sor-file`, `admin-probe-sor-claim`,
`admin-pull-claims-by-number`, `analyze-claim-document`, `synthesize-claim-extraction`,
`save-claim-analysis`, `review-claim-synthesis`, `approve-reconcile`,
`process-uploaded-claim`, `claims-chat`, `send-email`, `admin-user-actions`,
`generate-backup-codes`, `verify-backup-code`, `admin-regenerate-backup-codes`,
`admin-reset-user-mfa`.

Per-function `verify_jwt` settings come from `supabase/config.toml`.

---

## 7. How to run & access locally

```bash
npm install      # if node_modules missing
npm run dev      # Vite dev server → http://localhost:8080  (LAN: http://192.168.1.190:8080)
```

Access path (3 layers):
1. **Access gate** → see `DEMO-CREDENTIALS.local.md` (gate User ID / Password)
2. **Login** → `sb@spej.ai` (password in `DEMO-CREDENTIALS.local.md` / `.env`)
3. **Dashboard** → Review Queue with the 3 claims → synthesis → click citations/docs to view PDFs.

There is **no hosted/public URL** — the front end is local-only. (Optional next step:
deploy to Vercel for a shareable URL.)

---

## 8. Credentials & secrets (locations only)

- `.env` (gitignored) holds: `VITE_SUPABASE_PROJECT_ID`, `VITE_SUPABASE_URL`,
  `VITE_SUPABASE_PUBLISHABLE_KEY` (public), `SUPABASE_SERVICE_ROLE_KEY` (god-mode),
  `SUPABASE_ACCESS_TOKEN` (Management API). Vite only bundles `VITE_`-prefixed vars,
  so the service key + access token are **not** exposed to the browser.
- `DEMO-CREDENTIALS.local.md` (gitignored) — quick reference of the actual access
  values (gate code, admin login, project ref, DB pooler).
- The **service-role key + access token can be deleted from `.env`** now that the
  restore + deploy are done (the running app doesn't need them); rotate in the
  dashboard if desired.

---

## 9. Known gotchas / notes
- **`src/integrations/supabase/types.ts` is a drifted snapshot** (missing some
  columns) → `tsc --noEmit` shows pre-existing type errors, but `vite build` passes
  (esbuild, no typecheck). Regenerate with `supabase gen types typescript
  --project-id fihahgtxitixjkoegunk` (Management API; needs the access token — the
  `--db-url` form needs Docker, which isn't installed).
- ESLint has many **pre-existing** `no-explicit-any` errors; not introduced here.
- Line-ending CRLF warnings on commit are benign.
- `pg` is present in `node_modules` via `npm install pg --no-save` (not in
  package.json) — used only for admin SQL over the pooler.

---

## 10. Outstanding / possible next steps
- **Deploy the front end** (e.g., Vercel) for a public demo URL — not done yet.
- Optionally **scrub** `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_ACCESS_TOKEN` from `.env`.
- Optionally **regenerate `types.ts`** to clear the type drift.
- AI + cron stay **off** by design for the demo.

## Git history
```
63b3545 Rename site title to "Project C200 Demo Portal"
c54d230 Add pre-login access gate over the auth page
797431a Disable mandatory MFA for the demo environment
99eaf27 Switch to Spej AI Office dark theme + real favicon
66fb35c Repurpose into Spej-branded, source-agnostic template
f63e964 Initial commit: import supabase-claim-companion source
```
