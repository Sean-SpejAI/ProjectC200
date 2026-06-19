# ImageRight 3-Claims — Access Diagnosis (2026-06-17)

> **✅ RESOLVED (2026-06-17).** Root cause was the IIS **app-pool identity** — the WebService ran as `webagent` (id 211), which lacked BI/PIP document-class permissions. Nodak corrected it to **`irservices` (id 6)** and then enabled **Windows Authentication (NTLM)** (Anonymous off); our proxy was updated to authenticate via `curl --ntlm`. All four claims now return their full BI/PIP records (EVANSON 0000325507 = 6,041 pages; DYE 0000312624 now found; etc.), with streaming PDF fetch verified. Authentication details: see memory `reference_imageright_authentication` and [2026-06-17-ImageRight-SOAP-Call-Sequence.md](2026-06-17-ImageRight-SOAP-Call-Sequence.md). The analysis below is the diagnostic record that led to the fix.

> **Revision note (read first):** an early draft concluded the documents "live in Production" — that was an unsupported inference and is **retracted** (the engineer confirms they're in **test**). What is *established*: our session authenticates — per `CurrentUser` — as account **`webagent` (id 211, "Web Agent")**, NOT `spejai`, and that session is **blind to BI/PIP document classes across the entire test drawer**, while the files/folders themselves are current. The engineer also reports "we have full permissions," but that was almost certainly checked against the **`spejai`** login, not account **211** (the identity our WebService calls actually run as). So the question is narrowed to **an account-identity / document-visibility issue for account 211** — settled by the decisive doc-ID test at the end. We are **not** asserting it's permissions as fact. Companion shareable doc: [2026-06-17-ImageRight-SOAP-Call-Sequence.md](2026-06-17-ImageRight-SOAP-Call-Sequence.md).

## TL;DR

An engineer at Nodak confirmed (via the ImageRight **desktop client**, in **test**) that three claims hold thousands of pages of BI/PIP documents. Our integration's per-claim pull returns almost nothing for them. A deep, read-only SOAP investigation shows:

> **In the test ImageRight environment our integration connects to, our session — account `webagent` (id 211), not `spejai` — cannot see any BI/PIP document classes, on these claims or anywhere in the drawer. The files and their folder skeletons ARE present and recently modified; their document contents are invisible to account 211. It is NOT a wrong environment and NOT a page-format filter on our side (our session never receives the `Document` object, so there are no pages to filter). It is an account-211 visibility/permissions question — settled by the decisive doc-ID test below.**

Our SOAP traversal is verified correct (it pulls correspondence/declarations/statements — and historically some bills/medical — from other claims with the same code). Nothing needs to change in our code to retrieve these claims **once account 211 can see their documents**.

## The three claims (as `webagent` sees them today)

| Claim # | Name (file description) | Desktop client (admin) shows | Our account (`webagent`) sees |
|---|---|---|---|
| 0000312624 | DYE | 1,538 pages | `findFiles` → **0 files** (not visible in the drawer to webagent) |
| 0000325507 | EVANSON (fileId 89462305) | 6,042 pages (Claimant-01 ≈ 5,932) | File visible; **6 docs** (SG11 + 5 cut CORR); Claimant-01 folder **empty** |
| 0000360689 | VALADEZ (fileId 104999104) | 507 pages (Claimant-02 "…CVD, BI") | File visible; **3 docs** (SG11, STAT, MAIL); Claimant-02 folder **empty** |
| **0000264463** | HUST (fileId 60576567) | **`BIDO – MAYO CLINIC` (288p) on screen NOW** | **9 docs** (SG11/CORR/STAT skeleton); **no `Claimant-01` folder, no BIDO at all** |

**Proof point — 0000264463:** the engineer's live screenshot shows a `BIDO – MAYO CLINIC` 288-page medical document. Our session doesn't receive that `Document` *or even its `Claimant-01` folder*. This is the cleanest demonstration that (a) the data is present in this exact environment, and (b) the gap is upstream of any page handling — account 211 simply isn't shown the BI content.

## What we connect to

| Property | Value |
|---|---|
| ImageRight WebService | `http://192.168.11.179/imageright.webservice/IRWebService40.asmx` (over the StrongSwan VPN from `nodak-prod`) |
| Host header | `irtest-appsvr.nodakmutual.com` |
| Connection (`connName`) | **`Test`** (only connection the appsvr exposes — `AvailableConnections` → `["Test"]`) |
| Login username | `spejai` → resolves to security account **`webagent`** (id `211`, "Web Agent"), **view-only** (`EffectivePermissions=1`) |
| Drawer | CLMS (id `1383`) |

## Evidence (read-only probes, 2026-06-17)

| Probe | Result | What it tells us |
|---|---|---|
| `CurrentUser` | Account = **`webagent`** (id 211, "Web Agent"), `UserFlags=UserCannotChangePassword` | We are a low-privilege service account, not a human/admin user. |
| `GetPermissions` (file + folders) | **"Permissions denied. ID:-1"** | `webagent` lacks the right to even read ACLs — confirms a restricted service account. |
| `GetObject` (Claimant-01 folder, EVANSON) | `DateLastModified=2026-05-13`, `EffectivePermissions=1`, `Content` empty | The folder is **current** (recently modified) and readable — but its document content is empty *to webagent*. |
| `FindDocumentsEx` per claim (independent of folder walk, `includeDeleted=true`) | EVANSON 6, VALADEZ 3 — skeleton docs only | A server-side search that is **also permission-trimmed**; returns nothing webagent can't see. |
| **Drawer-wide `FindDocumentsEx`** (all CLMS, docs created 2026-05-01…14) | **65 docs — 100% `CORR` + `MAIL`. Zero BIDO / PIPR / PIPB / medical / bills.** | Across the *entire* drawer in the freshest window, `webagent` sees **no BI/PIP document classes at all** — pointing to a class-level restriction (or those classes not being loaded). |
| `EffectivePermissions` / `ObjectPermissions` on folders | `eff=1`, no `Deny` | Folder-level access is fine. The restriction is at the **document-class** layer, which the folder object does not expose. |

> Note: `MaxDocDateUTC` returns `0001-01-01` for *every* folder in this env — even folders holding the SG11 — so it is **not** a usable signal here.

## What's established, and the two things still to settle

- The folders, files, and names match the desktop client exactly and are recently modified (e.g. EVANSON `Claimant-01` `DateLastModified=2026-05-13`) → the data is **present in this test env**, not a different/missing environment.
- Our session runs as account **`webagent` (id 211)**, not `spejai`, and sees **no BI/PIP classes anywhere** in the drawer.
- `GetContent` and `FindDocumentsEx` are both server-side permission-trimmed, so documents account 211 isn't permitted **simply don't appear** — no error, and we cannot enumerate what we cannot see. (This is also why it's **not** a PDF/page filter on our side — there's no `Document` to fetch pages for.)
- **Re: "we have full permissions":** the relevant identity is **account 211**, not `spejai`. The check should be repeated against 211. If 211 genuinely has full rights and still can't see the docs, the cause is something other than ACLs (e.g. a security-class / workflow state) — the doc-ID test distinguishes that from a permissions gap.
- The one alternative we can't exclude from our side: the BI/PIP documents aren't in the WebService's `Test` database at all (despite the matching folder). The engineer seeing them in test argues against this; the doc-ID test confirms it either way.

## What we need from Nodak / Vertafore

1. **Re-check permissions against account `webagent` (id 211), not `spejai`** — specifically whether account 211's security group is granted the **BI/PIP document classes** (BIDO "BI Documents", PIPR "PIP Records", PIPB, PIPC, MATD, IME, etc.). Our session sees zero of these classes anywhere in the test drawer.
2. **Decisive doc-ID test:** open one BI document the engineer can see (e.g. 264463's `BIDO – MAYO CLINIC`), read its ImageRight **object/document ID** (right-click → Properties), and send it to us. We query that exact ID as account 211 via `GetDocumentByRef` / `GetPages`:
   - **"Permissions denied"** → it's account 211's permissions (grant 211 the BI/PIP classes / security class, then we re-run the probe; a flip to `documents_present` confirms the fix, and the same grant is applied across the BI corpus).
   - **"not found" / empty** → the document isn't in the WebService's `Test` database despite the matching folder → a server-side data/visibility question for Vertafore.

## How to re-verify in one command

- **Edge function** `admin-probe-imageright-claim` (service-role bearer; same auth as `admin-inspect-imageright-file`):
  ```
  POST https://<project>.supabase.co/functions/v1/admin-probe-imageright-claim
  Authorization: Bearer <sb_secret_* service-role key>
  { "claim_number": "0000325507" }
  ```
- **Proxy routes** (on `nodak-prod`, bearer `PROXY_SHARED_SECRET`): `GET /imageright/claims/:claimNumber/probe`, `GET /imageright/connections`.

Returns a verdict (`file_not_found_in_environment` | `file_present_empty` | `file_present_sparse` | `documents_present`) plus raw counts from BOTH our recursive pull path and the independent `FindDocumentsEx` search, a `byType` breakdown, and the folder summary — all reflecting **what our account-211 session can see**. A `file_present_sparse` verdict means substantive content is not visible to account 211 here — either not loaded, **or** restricted by ImageRight permissions; the doc-ID test distinguishes which.

## Appendix — reproducible raw probe

From `nodak-prod` (Node 20+, the proxy's `soap.js`, the VPN). Credentials come from the project-root `.env` (`IR_USERNAME`/`IR_PASSWORD`), base64-passed so they never appear in plaintext:

```bash
ssh nodak-prod "cd /opt/imageright-proxy && IRU64=... IRP64=... node --input-type=module" <<'NODE'
const { SoapSession, findDocumentsByFileNumber, getAvailableConnections } =
  await import('file:///opt/imageright-proxy/soap.js');
const sess = new SoapSession({
  endpoint: 'http://192.168.11.179/imageright.webservice/IRWebService40.asmx',
  hostHeader: 'irtest-appsvr.nodakmutual.com',
});
await sess.login(<user>, <pass>, 'Test');
console.log(await getAvailableConnections(sess));                       // -> ["Test"]
console.log(await sess._call('CurrentUser',
  '<ir:CurrentUser><ir:securityToken>'+sess.token+'</ir:securityToken></ir:CurrentUser>')); // -> webagent (id 211)
console.log((await findDocumentsByFileNumber(sess, '0000325507')).length);  // -> 6 (skeleton only)
NODE
```

WSDL: [docs/IRWebService40.wsdl](IRWebService40.wsdl) — re-verified against the live service on 2026-06-17; schema byte-identical. The full operation catalogue confirms there is no recursive/tree/alternate enumeration operation that would change this outcome.
