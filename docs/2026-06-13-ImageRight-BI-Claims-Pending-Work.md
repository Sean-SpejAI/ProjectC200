# 2026-06-13 — ImageRight BI Claims: Pending Work

## Context

This captures the outstanding work after the 2026-06-12/13 session: the bodily-injury (BI) claim load into prod, the claim-type and citation fixes, the SOAP pull verification, and the new ImageRight inventory endpoint. Shipped items are listed briefly for context; the focus is the **pending** work below.

## Shipped (for reference)

- **Claim type now AI-inferred** — PR #90, live in prod. Synthesis infers auto/home/farm/life and stamps the claim. Verified on WISEMAN (0000385134) → now correctly "home".
- **Citations fixed** — PR #90, live. Page references read `<document name> p. N` instead of an internal UUID, and the double-wrapping is gone. Verified on WISEMAN.
- **Folder-filtered pull capability** — PR #90, live. `admin-pull-claims-by-number` accepts per-claim folder include/exclude + document-type filters.
- **SOAP pull verified correct** — 2026-06-13. Our enumeration matches the WSDL and the live service; the three flagged claims are simply not populated in the ImageRight **test** environment (see the inventory finding below).
- **Inventory / inspect endpoint** — PR #91, live. `admin-inspect-imageright-file` (by `claim_number` or `file_id`) returns a claim's full contents including deleted/cut items, so we can verify what ImageRight actually holds.
- **Re-synthesis** of the 14 visible claims, to apply the citation + claim-type fixes to existing data.

---

## Pending work

### 1. Blocked on Nodak (external dependency)
Email sent to the Nodak team on 2026-06-13 asking them to:
- **Load claims 325507, 312624, 360689 (full folders + documents) into the ImageRight test environment.** What's in test today: 360689's "Shelley (Michelle) Knippling - CVD, BI" folder exists but is **empty**; 325507 has only a 2023 Declarations document; 312624 isn't found at all.
- **Confirm the Dye claim number (312624)** — not found in the test claims drawer under any zero-pad format, so possibly mistyped.
- Alternative if they prefer: connect our proxy to **production** ImageRight instead (would need the prod server address + a service login). Not the current plan, but a quick pivot on our side.

### 2. Ready to run once Nodak loads the claims (us — no new code needed)
1. Inventory-verify each claim via `admin-inspect-imageright-file` (by `claim_number`) — confirm the BI documents are present and **live** (not deleted/cut) before pulling.
2. Run `admin-pull-claims-by-number` with the per-claim folder filters the client specified:
   - **325507** → only the BI documents (type code `BIDO`) under the Michael Evenson claimant folder.
   - **312624** → all folders under "Insured - Da'Shiya Dye" and "Claimant - Nakrya Dye".
   - **360689** → all folders under the Knippling claimant folder, **excluding** "Material Damage".
   - First confirm the exact folder names from the inventory output — they may differ slightly from the client's wording (e.g. the test folder is "Shelley (Michelle) Knippling - CVD, BI").
3. Let the documents flow through fetch → analysis → synthesis, then confirm the claims render correctly in the portal.

### 3. Unfinished overnight BI load (carried over)
As of the last check (2026-06-12), only **13 BI claims are visible** in the portal versus the ~100 target. **31 claims are stuck part-way** (30 still have documents that never finished downloading), and **123 documents are parked** awaiting their PDFs.
- **Decision needed:** drain that backlog so the rest of the BI sample becomes visible. This is independent of the three specific claims above.

### 4. Repo / deployment hygiene
- **`imageright-sync` changes are deployed to prod but not committed.** The top-N selection work (parallelism, the document-count band, retry-on-empty) currently lives only in the local working tree. Commit + PR so `main` matches what's running in prod.
- **Stray file** `docs/BI SUMMARY 359226.docx` is sitting untracked in the repo — remove it or move it out of the working tree.
- **Dev / Stage parity:** the edge functions and proxy changes from this session were deployed to **prod** only (`oopjlechxxbyisntbtvw`). Deploy the same to the dev and stage environments if parity is wanted. (The proxy on nodak-prod is shared by dev + prod, so only the Supabase edge functions need re-deploying per environment.)

### 5. Quality gaps (lower priority)
- **Wage loss and medical-provider details** are not reliably populated by the synthesis step (only diagnosed injuries fill consistently). Worth investigating the synthesis prompt/inputs.
- **Leftover scheduled jobs** from the overnight run — the per-minute sync keepalive job and the one-off BI-filter job for run `77a40523` — may still be active and can likely be turned off. Verify current state before disabling.

---

## Key references
- **ImageRight environment:** test server `irtest-appsvr.nodakmutual.com` (`192.168.11.179`); proxy runs on the nodak-prod VM, port 8080.
- **Prod Supabase project:** `oopjlechxxbyisntbtvw`.
- **Inventory endpoint auth:** the admin edge functions require the `sb_secret_*` service key (from the Supabase Management API `api-keys?reveal=true`), not the legacy JWT.
- Related: [2026-06-10-ImageRight-Attribute-Discovery.md](2026-06-10-ImageRight-Attribute-Discovery.md).
