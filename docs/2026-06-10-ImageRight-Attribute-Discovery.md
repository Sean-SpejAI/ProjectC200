# ImageRight Attribute Discovery — 2026-06-10

Purpose: enumerate every custom attribute the ImageRight (Vertafore) server exposes via SOAP so we can decide whether to add a SOAP-layer BI / coverage-type filter to `imageright-sync`. See [`reference_imageright_bi_filtering.md`](../../../.claude/projects/c--Users-sean-repo-ncp-supabase-claim-companion/memory/reference_imageright_bi_filtering.md) for the prior analysis.

## Method

Added 4 bearer-token-protected admin routes to [`imageright-proxy/server.js`](../imageright-proxy/server.js) (+ corresponding SOAP helpers in [`soap.js`](../imageright-proxy/soap.js)):

- `GET /imageright/discover/attribute-defs` → calls SOAP `GetAttributeDefs`. System-wide catalog.
- `GET /imageright/discover/attribute-rules/:typeId` → calls SOAP `GetAttributeRules`. Per-type attribute associations.
- `GET /imageright/discover/attributes/:objectId` → calls SOAP `GetAttributes`. Values set on one specific File/Folder/Document.
- `GET /imageright/discover/file-type/:name` → calls SOAP `GetFileType`. Resolves a programmatic type name (e.g. "CLMS") to its numeric typeId.

Ran against the prod ImageRight environment from nodak-prod (`az vm run-command invoke` → localhost:8080 proxy → SOAP over VPN). Sample fileIds captured from prod corpus pre-wipe:

| Role | fileId | claim_number | claimant | incident_description |
|---|---|---|---|---|
| BI candidate (rear-end, not fault) | 86402200 | 0000317024 | CAMMUE, ISAAC | Insured rear-ended - Ins Not fault |
| BI candidate (rear-end, ins fault) | 111419108 | 0000375246 | ISACK, ABDULLAHI ABDI | Rear-end adv - Ins fault |
| BI candidate (rear-end, ins fault) | 114170030 | 0000381649 | WHITE, HEIDI | Rear-end adv - Ins fault |
| Non-BI: Fire | 94675021 | 0000336807 | — | Fire |
| Non-BI: Hail | 101780744 | 0000353394 | — | Hail |
| Non-BI: W/S Repair | 114350877 | 0000382043 | — | W/S Repair |
| Non-BI: Glass Replacement | 111176057 | 0000374526 | — | Glass Replacement |

## Findings

### CLMS file type

`GetFileType("CLMS")` returns **typeId = 1384** (the file-type id; distinct from drawer id 1383, which is what `FindFilesEx` filters on via `drsaDrawerId`).

### CLMS attribute rules — exactly 4 attributes, all optional, all string-typed

`GetAttributeRules(1384)` returns:

| id | name | type | mandatory |
|---|---|---|---|
| 398 | ADJUSTER CODE | atString | false |
| 402 | CAUSE OF LOSS | atString | false |
| 413 | DATE OF LOSS | atString | false |
| 428 | POLICY NUMBER | atString | false |

### Sample claim attribute values

`GetAttributes(<fileId>)` returns the same 4 attributes populated on every sample claim. Full dump:

| fileId | CAUSE OF LOSS | POLICY NUMBER prefix | ADJUSTER CODE | DATE OF LOSS |
|---|---|---|---|---|
| 86402200 (BI) | `Insured rear-ended - Ins Not fault` | `PAND` | 043,135,168 | 05/16/2023 |
| 111419108 (BI) | `Rear-end adv - Ins fault` | `OAND` | 352,320,151 | 07/27/2025 |
| 114170030 (BI) | `Rear-end adv - Ins fault` | `PAND` | 370,204 | 12/09/2025 |
| 101780744 (Hail) | `Hail` | `HOND` | 150,334 | 07/29/2024 |
| 94675021 (Fire) | `Fire` | `FRNE` | 136 | 01/21/2024 |
| 114350877 (W/S) | `W/S Repair` | `PASD` | GTL,099 | 12/29/2025 |
| 111176057 (Glass) | `Glass Replacement` | `PASD` | GTL,099 | 07/09/2025 |

No BI/coverage/reserve/injury attribute appears in any sample.

### System-wide attribute catalog scan

`GetAttributeDefs` returned **178 attribute definitions** total. Grep across `name + displayName + description` for any of `bi`, `bodily`, `coverage`, `lob`, `line of business`, `injur`, `reserve`, `loss type`, `claim type`, `severity`, `liabil`:

- **id=426 `LINE OF BUSINESS`** (atString, enabled) — present in the catalog, NOT in the CLMS attribute rules, NOT populated on any sample claim.
- All other matches were unrelated `Global*` server-config attrs (export paths, route tables, etc.).

So `LINE OF BUSINESS` is defined system-wide but **not wired to the CLMS file type and not populated**. Asking Nodak IT to begin populating it would be a multi-quarter process and would only cover claims created after the wiring change.

## Decision

**Ship top-N-by-doc-count alone. No BI custom-attribute filter.**

- The only signal that distinguishes BI from non-BI at the SOAP layer is `CAUSE OF LOSS` (id=402, free-text string). That's the same signal we already extract into `claims.incident_description` during pull, so post-pull filtering on it costs nothing extra. SOAP-layer filtering on it via `fsaCustom` + `coLike` *is* possible (Id=402, AType=`atString`, ATarget=`catSelf`, CompOp=`coLike`, Value=`%<pattern>%`), but it's a regex-style match against free-text; same accuracy as the post-pull filter, no real gain.
- The `POLICY NUMBER` prefix (`PAND`/`OAND`/`HOND`/`FRNE`/`PASD`/...) **does** encode a coverage line of business — but it's a Nodak naming convention, not formal data. We can use it as a secondary heuristic if we ever need a stronger BI filter.

**Implication for the current plan**: the `bi_attribute_id` / `bi_attribute_value` params introduced in the plan's `SyncRequest` are dropped. Top-100-by-PDF-count proceeds without any coverage-type filter. The corpus will still skew BI-heavy organically because BI claims accumulate more docs than property claims (FNOL + police report + medical records + bills + demand letter + correspondence ≫ glass estimate + invoice).

## Follow-up options (not in this PR)

1. **Add a `cause_of_loss_match` filter** (post-pull or via `fsaCustom`+`coLike`) — narrows the candidate pool BEFORE top-N. Would tighten the corpus further but adds a regex param to manage. Easy to layer on later if needed.
2. **Ask Nodak IT to populate `LINE OF BUSINESS`** on new claims and consider a backfill for active claims. Real solution but slow.
3. **Use `POLICY NUMBER` prefix as a coverage heuristic**. Quick win — `PAND` and `OAND` are personal auto (BI candidates); `HOND` is home; `FRNE` is fire; `PASD` is auto with glass-only coverage. Could ship as a post-pull tag.

## Discovery endpoints (left deployed)

The 4 discovery routes remain on the proxy. They're bearer-token-protected and cheap. Useful any time we need to investigate a new ImageRight attribute. Raw dumps from this session live at `/tmp/discovery/{defs,rules-clms,attrs-*}.json` on the nodak-prod VM.
