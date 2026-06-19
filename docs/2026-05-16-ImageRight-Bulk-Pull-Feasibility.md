# ImageRight bulk pull feasibility — claimant → claim → documents

**Question**: Can we pull all data from the ImageRight REST API organized as **claimant → claim number → documents**, filtered by a time period?

**Answer**: Yes — the API's native shape is already exactly this hierarchy. One caveat: the file search endpoint capped my probes at 1000 records per call and the pagination keys I guessed all returned empty arrays. For a wide date range we'll either slice the window into smaller buckets or get the correct pagination syntax from Vertafore.

## Mapping ImageRight concepts to Nodak's mental model

| Nodak concept | ImageRight concept | Where the data lives |
|---|---|---|
| Drawer | Drawer | `CLMS` drawer, id `1383` (the only one — confirmed) |
| **Claim** (one row per claim) | **File** | One File per claim under the CLMS drawer |
| **Claimant name** | `file.description` | e.g. `"BELZER, PAUL"` |
| **Claim number** | `file.fileNumberPart1` | e.g. `"0000372229"` |
| Additional claim attrs | `file.attributes[]` | `ADJUSTER CODE`, `CAUSE OF LOSS`, `DATE OF LOSS`, `POLICY NUMBER` |
| **Documents** for a claim | `Document` records with `fileId` = the claim file's id | `documentName`, `documentTypeDescription` (e.g. `"FNOL - FNOL"`), `pageCount`, `dateCreated`, etc. |
| Document binaries (PDF/image) | `Page` records inside a Document | Fetched via `GET /api/files/{fileId}/pages/{pageId}/content` |

The hierarchy is one-to-one with what the user described. No reshaping needed.

## Working endpoints (verified live against `irtest-appsvr.nodakmutual.com:8093`)

| Verb | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/api/files/find` | `{}` or filter object | array of Files (claims) — capped at 1000 |
| `GET` | `/api/files/{fileId}` | — | single File with attributes |
| `POST` | `/api/documents/find` | `{"fileId": <id>}` | array of Documents for the claim |
| `GET` | `/api/documents/{docId}` | — | single Document |
| `GET` | `/api/documents/{docId}/pages` | — | array of Pages in the doc |
| `GET` | `/api/files/{fileId}/pages/{pageId}/content` | — | page binary (PDF / image) |
| `POST` | `/api/folders/find` | `{"fileId": <id>}` | folders (sub-containers within a file — not needed for our use case) |

## Filter keys that work on `/api/files/find`

| Key | Type | Notes |
|---|---|---|
| `DateCreatedFrom` | ISO date or datetime | January 2025 alone returned 103 files |
| `DateCreatedTo` | ISO date or datetime | use with `DateCreatedFrom` |
| `LastModifiedFrom` / `LastModifiedTo` | ISO date | September 2025 modifications hit the 1000 cap |
| `fileTypeId` | int | `1384` = CLMS |
| `drawerId` | int | `1383` = CLMS drawer |
| `fileNumberPart1` | string | exact match on claim number — works |

**Filter keys that silently returned `[]` in probes** (i.e. either wrong key name or no semantics): `description`, `Description`, `createdAfter`, `pageSize`, `PageSize`, `top`, `limit`+`offset`, `Skip`+`Take`, `FromIndex`+`ToIndex`. We'll need Vertafore docs or another guess pass to find the right pagination keys.

## Sample data shape (one File / "claim")

```json
{
  "id": 110504802,
  "fileTypeId": 1384, "fileTypeName": "CLMS",
  "drawerId": 1383, "drawerName": "CLMS",
  "description": "BELZER, PAUL",           // <- claimant
  "fileNumberPart1": "0000372229",         // <- claim number
  "fileNumberPart2": "", "fileNumberPart3": "",
  "isDeleted": false, "isTemporary": false,
  "dateCreated":  "2025-06-23T16:46:06.123",
  "lastModified": "2025-09-10T19:44:36.213",
  "attributes": [
    { "name": "ADJUSTER CODE",  "value": "25C,150" },
    { "name": "CAUSE OF LOSS",  "value": "Wind" },
    { "name": "DATE OF LOSS",   "value": "06/20/2025" },
    { "name": "POLICY NUMBER",  "value": "FRND000704531" }
  ]
}
```

## Sample data shape (one Document under that claim)

```json
{
  "id": 110504871,
  "file": { "id": 110504802, "description": "BELZER, PAUL", "fileNumberPart1": "0000372229" },
  "folder": { "id": 110504870, "folderTypeDescription": "Claim Information" },
  "documentName": "FNOL",
  "documentTypeDescription": "FNOL - FNOL",
  "pageCount": 3,
  "dateCreated":      "2025-06-23T16:48:13.347",
  "dateLastModified": "2025-06-23T16:48:13.613",
  "documentDate":     "2025-06-23T00:00:00",
  "receivedDate":     "2025-06-23T16:47:41",
  "deleted": false,
  "attributes": [
    { "name": "ER_SUBJ", "value": "STORM - Claim # 0000372229" }
  ]
}
```

Per-document attributes (`ER_SUBJ`, etc.) are also inline. No second roundtrip needed for metadata.

## Recommended pull algorithm

Two API calls per claim — one search to find the claims, one per claim to enumerate documents:

```
files = POST /files/find { DateCreatedFrom: T0, DateCreatedTo: T1 }
                       (or LastModifiedFrom/To if "claims active in window" is the intent)
for each file in files:
    docs = POST /documents/find { fileId: file.id }
    yield {
      claimant: file.description,
      claimNumber: file.fileNumberPart1,
      attrs: file.attributes,
      documents: docs.map(d => ({
        id: d.id,
        name: d.documentName,
        type: d.documentTypeDescription,
        dates: { created: d.dateCreated, modified: d.dateLastModified, doc: d.documentDate },
        pages: d.pageCount,
      }))
    }
```

Latency-wise that's `1 + N` round trips for `N` claims. The test server's `documents/find` returned a small payload (~8 KB for 6 docs), so per-claim is cheap. For large pulls we'd parallelize the per-claim loop with a modest concurrency cap (4-8) to avoid hammering the on-prem server.

## The 1000-record problem

`POST /files/find` is silently capped at 1000 records per response. None of the pagination key variants I guessed (`pageSize`, `top`, `limit`/`offset`, `Skip`/`Take`, `FromIndex`/`ToIndex`) made a dent. Three paths forward:

1. **Slice the date window** — keep each `DateCreatedFrom`/`To` request to a range that produces fewer than 1000 files. Looking at January 2025 (103 records), Nodak appears to run on the order of ~100 new claims/month, so monthly slices would stay well under the cap with headroom.
2. **Ask Vertafore for the pagination syntax** — Chris/Tom can confirm in a sentence. This is the right long-term answer.
3. **Pull the unsorted dump and post-filter** — works but wasteful.

Recommend path 1 for v1 (it's robust and obvious), with path 2 as a parallel ask so we can drop the slicing later.

## What this enables

The existing [imageright-proxy](../imageright-proxy/server.js) on the Azure VM already has the auth pattern (Bearer to-proxy, AccessToken to ImageRight) and a `GET /api/files/{fileId}/pages/{pageId}/content` route for binary fetch. Adding two new routes on the proxy — `/files/find` (POST passthrough with date filter) and `/documents/find` (POST passthrough with fileId) — gets us the rest. After that, an edge function in Supabase can orchestrate the per-claim pull and feed claims into the existing PDF-analysis pipeline (`analyze-claim-document`) one document at a time.

## Reproducible probe

```bash
# From any host that can ssh to the nodak VM:
set -a; source .env; set +a
JSON=$(printf '{"UserName":"%s","Password":"%s"}' "$IR_USERNAME" "$IR_PASSWORD")
echo "$JSON" | ssh nodak 'cat > /tmp/ir_auth.json && chmod 600 /tmp/ir_auth.json'

ssh nodak '
TOKEN=$(curl -sk --resolve irtest-appsvr.nodakmutual.com:8093:192.168.11.179 \
  -H "Content-Type: application/json" --data @/tmp/ir_auth.json \
  "https://irtest-appsvr.nodakmutual.com:8093/api/authenticate")

# All claims created in Jan 2025
curl -sk --resolve irtest-appsvr.nodakmutual.com:8093:192.168.11.179 \
  -H "Authorization: AccessToken ${TOKEN}" -H "Content-Type: application/json" \
  --data "{\"DateCreatedFrom\":\"2025-01-01\",\"DateCreatedTo\":\"2025-01-31\"}" \
  "https://irtest-appsvr.nodakmutual.com:8093/api/files/find" | jq "length"

# All documents for one claim
curl -sk --resolve irtest-appsvr.nodakmutual.com:8093:192.168.11.179 \
  -H "Authorization: AccessToken ${TOKEN}" -H "Content-Type: application/json" \
  --data "{\"fileId\":110504802}" \
  "https://irtest-appsvr.nodakmutual.com:8093/api/documents/find" | jq "[.[] | {id, documentName, pageCount, dateCreated}]"
'
```
