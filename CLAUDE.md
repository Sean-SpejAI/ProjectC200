# Project Instructions

## What this is

A Spej claims **Demand Packet Review Portal** — an AI-assisted insurance claims
document review app. Adjusters get claim documents (demand letters, medical records,
bills) into the system, and the pipeline uses Google Gemini to extract structured data,
score completeness, and present findings for human review.

Stack: Vite + React + TypeScript + Tailwind/shadcn (front end), Supabase (Postgres,
Auth, Storage, Edge Functions) on the back end.

This repo is a **client-agnostic template**. It is meant to be cloned per client: the
processing pipeline stays the same, only the document **source** changes.

## Execution style

The user pre-approves plans and then expects autonomous execution. Once a plan is
approved, run commands without asking for per-step confirmation (file edits, builds,
Supabase deploys). Pause only if you discover something materially different from the
approved plan, or before genuinely destructive actions outside the plan's scope
(e.g. force-pushing, dropping DB tables).

## Documentation

All files in `/docs` follow the naming convention `YYYY-MM-DD-Filename.md`
(e.g. `2026-04-08-System-Architecture.md`). Exception: durable reference docs without a
date (e.g. `SystemOfRecord-Connector-Contract.md`).

## System of Record (SOR) ingestion — dormant in this environment

Claims/documents can be ingested from a client's **System of Record (SOR)** — whatever
document/claims platform that client runs — through a thin per-client **connector**. The
edge functions (`sor-sync`, `fetch-sor-document`, `reload-claim-from-sor`, the
`admin-*-sor-*` diagnostics, and `_shared/sor-client.ts`) speak a stable JSON +
`application/pdf` HTTP contract; they don't know the upstream protocol.

- The connector contract is documented in
  [docs/SystemOfRecord-Connector-Contract.md](docs/SystemOfRecord-Connector-Contract.md).
- **This environment has no connector configured** — `SOR_PROXY_URL` / `SOR_PROXY_TOKEN`
  are intentionally unset, so the SOR functions are inert and nothing connects outbound.
  Demo claims are loaded manually via the in-app upload flow.
- Documents tagged `source = 'sor'` came from a connector; `source = 'manual'` came from
  portal upload. Both run through the identical downstream pipeline
  (analyze → synthesize → review).

To wire up a real source for a new client: build a connector that satisfies the contract,
deploy it, and set the two function secrets. No pipeline or schema changes are required.

## Supabase

A fresh Supabase project backs this environment. Link the CLI with
`npx supabase link --project-ref <ref>` (auth via `SUPABASE_ACCESS_TOKEN`). Migrations
live in `supabase/migrations/` and define the `sor_*` columns/tables plus the
`claims` / `claim_documents` schema. Regenerate `src/integrations/supabase/types.ts` with
`npx supabase gen types typescript` after schema changes.

## Branding

Spej brand: teal `#4ecdc4`, navy `#1a2332`, off-white `#f8f9fa` background. Color tokens
live in [src/index.css](src/index.css) (shadcn HSL variables); the logo is
`public/logo.png`.
