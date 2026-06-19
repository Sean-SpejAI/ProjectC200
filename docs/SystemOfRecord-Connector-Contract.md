# System of Record (SOR) Connector Contract

This app ingests claims + documents from a client's **System of Record (SOR)** — whatever
document/ECM/claims platform that client runs — and then runs them through a
source-agnostic processing pipeline (ingest → analyze → synthesize → review).

To keep the pipeline reusable across clients, the SOR is reached through a thin
**connector**: a small per-client HTTP service that fronts the client's system and
speaks the JSON + `application/pdf` contract below. The edge functions never see the
upstream protocol — a connector may implement SOAP, REST, a vendor SDK, a file drop,
etc. behind this interface.

> **This environment is dormant.** No connector is configured here (the 3 demo claims
> are loaded manually). To wire up a real source, build a connector that satisfies this
> contract and set the two secrets below. With them unset, the SOR ingestion functions
> are inert and nothing connects outbound.

## Configuration

The pipeline talks to the connector through two Supabase function secrets, read in
[`supabase/functions/_shared/sor-client.ts`](../supabase/functions/_shared/sor-client.ts):

| Secret | Meaning |
|---|---|
| `SOR_PROXY_URL` | Base URL of the connector (e.g. `https://sor-connector.example.com`). |
| `SOR_PROXY_TOKEN` | Bearer token; sent as `Authorization: Bearer <token>` on every request. |

If either is unset, `clientFromEnv()` throws and the SOR functions do nothing — the
pipeline stays dormant.

## Transport & reliability

- **Auth:** every request carries `Authorization: Bearer ${SOR_PROXY_TOKEN}`.
- **Retries:** the client retries (bounded exponential backoff, ~3 attempts) on
  `408, 425, 429, 500, 502, 503, 504`. Other statuses are terminal.
- **Timeouts:** ~60s for metadata calls; up to 5 minutes for document content.
- The PDF endpoint treats a `4xx` (other than `401`) as a terminal "content unavailable"
  rather than a retryable failure.

## Endpoints

All paths are relative to `SOR_PROXY_URL`. "File" = a claim file; "document" = an item
within it.

### `GET /sor/health-upstream`
Liveness/credentials probe against the upstream system. Any `2xx` = healthy.

### `POST /sor/files/search`
Find claim files. Body sets **exactly one** filter:
```jsonc
{ "fileNumber": "0000372262" }            // exact claim number, OR
{ "dateModifiedFrom": "ISO", "dateModifiedTo": "ISO" }  // modified-date range, OR
{ "dateCreatedFrom": "ISO", "dateCreatedTo": "ISO" }    // created-date range
```
Response:
```jsonc
{ "files": [ { "fileId": 123, "claimNumber": "…", "fileNumber2": null,
               "fileNumber3": null, "description": "…" } ] }
```

### `GET /sor/files/:fileId`
Return a file with its full, flattened document tree.
```jsonc
{
  "file": { "fileId": 123, "claimNumber": "…", "fileNumber2": null,
            "fileNumber3": null, "description": "…", "dateLastOpened": "ISO|null" },
  "attributes": { "<name>": "<value|null>" },
  "documents": [ {
    "docId": 9, "parentFolderId": 4,
    "folderName": "…", "folderPath": ["root", "…"],
    "description": "…", "documentType": "…", "documentTypeCode": "BIDO",
    "pageCount": 12, "dateCreated": "ISO|null",
    "dateLastModified": "ISO|null", "documentDate": "ISO|null"
  } ]
}
```

### `GET /sor/documents/:docId/pdf`
Return the document as a single merged **`application/pdf`** binary. The page ids that
make up the PDF come back in a CSV response header `X-Sor-Page-Ids`. First bytes must be
`%PDF`.

### `GET /sor/files/:fileId/inventory?includeDeleted=true|false`
Diagnostic: every folder + document (optionally including deleted/cut items with delete
state). Returns the connector's JSON verbatim (`{ fileId, file, counts, objects[] }`).

### `GET /sor/claims/:claimNumber/probe`
Diagnostic: is this claim's data actually present in the connected environment? Returns a
verdict (`file_not_found_in_environment | file_present_empty | file_present_sparse |
documents_present`) plus traversal/search counts.

### `GET /sor/connections`
Diagnostic: list the backend connections the upstream exposes
(`{ connNameInUse, availableConnections[] }`).

## Mapping into the database

`sor-pull-claim.ts` upserts the tree into `claims` / `claim_documents` using the
`sor_*` columns (`sor_file_id`, `sor_document_id`, `sor_folder_path`, `sor_page_count`,
`sor_processing_tier`, `sor_removed_at`, …) and tags rows `source = 'sor'`
(vs `'manual'` for portal uploads). A new client only needs to implement the HTTP
endpoints above; the schema and downstream pipeline are unchanged.
