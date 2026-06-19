# Vertex AI Files API — 403 "insufficient authentication" — resolved 2026-06-08

> **Status: RESOLVED.** Oversize PDFs now route through a GCS bucket
> (`gs://nodak-claims-vertex-uploads`, in GCP project `black-heuristic-491320-c1`)
> via Vertex AI's `fileData.fileUri`. The original "broken Files API" diagnosis
> below was incorrect — see the post-mortem before this section.

## Post-mortem (2026-06-08)

**What we thought the problem was (May–June 2026):**
The code was calling `https://generativelanguage.googleapis.com/upload/v1beta/files`
to upload oversize PDFs. The 403 was filed as a GCP IAM / API-enablement gap,
and Bobby was asked twice — first to enable `generativelanguage.googleapis.com`
and grant `roles/aiplatform.user` to the service account, then later issued a
fresh service account in a fresh GCP project.

**What the problem actually was:**
The endpoint at `generativelanguage.googleapis.com` is the *Google AI* (formerly
MakerSuite / AI Studio) surface — a different Google product from Vertex AI.
It does not accept service-account OAuth tokens minted with the standard
`cloud-platform` scope, regardless of which IAM roles the service account holds
or which APIs are enabled on the GCP project. Both Bobby's rounds of changes
were on the wrong service.

**Verification that proved it:** ran the resumable-upload `curl` from a clean
Python client (no Supabase, no Edge function) with both the original SA and
the fresh `gemini-claims-service@black-heuristic-491320-c1.iam.gserviceaccount.com`.
Same `403 ACCESS_TOKEN_SCOPE_INSUFFICIENT` in both cases. The same token, hitting
Vertex AI at `aiplatform.googleapis.com/v1/projects/.../models/gemini-2.5-flash:generateContent`,
returned 200.

**The fix that landed:**
1. Bobby provisioned one GCS bucket (`gs://nodak-claims-vertex-uploads`,
   `us-central1`, uniform access) and granted the service account
   `roles/storage.objectAdmin` on it. One-time. No further GCP changes needed.
2. Code change in [supabase/functions/_shared/gemini.ts](../supabase/functions/_shared/gemini.ts)
   and [supabase/functions/analyze-claim-document/index.ts](../supabase/functions/analyze-claim-document/index.ts):
   - Deleted `uploadToGeminiFileAPI`, `streamUploadToGemini`, `waitForFileActive`,
     `deleteGeminiFile` — all hit the broken `generativelanguage.googleapis.com` surface.
   - Added `uploadPdfToGcs` / `deleteGcsObject` helpers — straight REST to
     `storage.googleapis.com` using the same Vertex SA token.
   - Renamed `generateWithGeminiFile` → `generateWithVertexFile`. Same `fileData.fileUri`
     shape it always used, but the URI is now `gs://nodak-claims-vertex-uploads/<uuid>-<filename>`
     instead of the broken Google AI Files API URL.
   - Oversize routing in `performAnalysis` and `performAnalysisWithProgress`:
     download bytes → upload to GCS → call Vertex with `gs://` URI → delete the
     GCS object in a `finally` block.
3. Bucket name configurable via `GCP_GCS_BUCKET` env var; defaults to the
   `nodak-claims-vertex-uploads` constant if unset.

**Why GCS specifically and not arbitrary HTTPS:** Vertex AI's `fileData.fileUri`
caps arbitrary HTTPS document URLs at **15 MB**. The same field with a `gs://`
URI allows up to 2 GB. The stuck docs were 23 MB and 47 MB, so HTTPS-from-Supabase
wasn't an option even though that would have required no GCP infrastructure.

**Lessons:**
- Reproduce externally before asking a vendor to change configuration. A 30-line
  Python client would have isolated the OAuth/scope mismatch immediately and
  saved Bobby two rounds of unnecessary work.
- Service names matter: `generativelanguage.googleapis.com` ≠ Vertex AI, even
  though both serve "Gemini" models. They have different auth models, different
  quotas, and different feature support.

---

## Original diagnosis (incorrect — preserved for history)

**Owner of action:** the GCP admin who manages the project hosting our Vertex AI service account.
**Owner of follow-up:** SpejAI (we re-trigger the stuck doc once IAM is fixed).

## Symptom

PDFs larger than 20 MB fail in production with:

```
Failed to start Gemini upload: 403 - Request had insufficient authentication
```

The row is written to `claim_documents.processing_error` and the doc lands in
`processing_status='failed'`. PDFs ≤ 20 MB are not affected — they take the
inline `generateContent` path and succeed.

Volume: roughly 1 doc/month based on observed size distribution. The Apr 1 → May 13
prod ingestion (2026-06-01) hit this exactly once on a 50 MB Declarations.pdf.

## Where it fails in code

[supabase/functions/_shared/gemini.ts:32](../supabase/functions/_shared/gemini.ts#L32)
(`uploadToGeminiFileAPI`) and [line 89](../supabase/functions/_shared/gemini.ts#L89)
(`streamUploadToGemini`) — both throw the message above when the initial
`POST https://generativelanguage.googleapis.com/upload/v1beta/files` returns 403.

Size routing:
[supabase/functions/_shared/types.ts:108](../supabase/functions/_shared/types.ts#L108)
sets `GEMINI_FILE_API_THRESHOLD = 20 MB`. Above that, the analyze function at
[supabase/functions/analyze-claim-document/index.ts:781](../supabase/functions/analyze-claim-document/index.ts#L781)
branches to the Files API path.

## Root cause

Both the inline `generateContent` path and the Files API path obtain the same
OAuth access token via
[supabase/functions/_shared/vertex-auth.ts](../supabase/functions/_shared/vertex-auth.ts)
with scope `https://www.googleapis.com/auth/cloud-platform`. The inline path
works, so the token itself is valid.

The 403 surfaces only on the Files API endpoint
(`generativelanguage.googleapis.com`). "Request had insufficient authentication"
is GCP-speak for *the token is recognized but the identity lacks the
permission for this endpoint*. Two failure modes are possible and both have to
be ruled out:

1. **The Generative Language API is not enabled** on the GCP project that owns
   the service account. Vertex AI on `aiplatform.googleapis.com` is a different
   API from the Files API on `generativelanguage.googleapis.com`. They have to
   be enabled independently.
2. **The service account lacks an IAM role** that grants
   `generativelanguage.files.create` (or whatever permission the Files API
   resumable-upload endpoint requires).

## Remediation steps (for GCP admin)

### 1. Identify the service account

The SA is configured as the `GOOGLE_SERVICE_ACCOUNT_JSON` secret on the prod
Supabase project (`oopjlechxxbyisntbtvw`). Its `client_email` field is the
SA email — it lives in your GCP project as
`<sa-name>@<project-id>.iam.gserviceaccount.com`.

Quick way to find it without retrieving the Supabase secret: in the GCP console,
open the project → IAM & Admin → Service Accounts. The SA used by this app
will have a recent activity timestamp and Vertex AI roles granted.

### 2. Enable the Generative Language API (if not already on)

```bash
gcloud services enable generativelanguage.googleapis.com --project=<project-id>
```

Idempotent — safe to run if already enabled.

### 3. Grant Vertex AI / Files API IAM role

Most likely sufficient:

```bash
gcloud projects add-iam-policy-binding <project-id> \
  --member="serviceAccount:<sa-email>" \
  --role="roles/aiplatform.user"
```

If the 403 persists after that, escalate to either:

- `roles/aiplatform.serviceAgent` (broader Vertex AI surface), or
- A custom role that includes `generativelanguage.files.*` permissions

### 4. Verify the fix

From any shell with `gcloud auth` to the GCP project, the following should
return HTTP 200 with an `X-Goog-Upload-URL` response header (the upload-session
URL). It currently returns 403 — that's the failure we are fixing.

```bash
ACCESS_TOKEN=$(gcloud auth print-access-token \
  --impersonate-service-account=<sa-email>)

curl -v -X POST \
  "https://generativelanguage.googleapis.com/upload/v1beta/files" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "X-Goog-Upload-Protocol: resumable" \
  -H "X-Goog-Upload-Command: start" \
  -H "X-Goog-Upload-Header-Content-Length: 1024" \
  -H "X-Goog-Upload-Header-Content-Type: application/pdf" \
  -H "Content-Type: application/json" \
  -d '{"file":{"displayName":"vertex-403-test.pdf"}}'
```

Expected after the grant: `HTTP/2 200` and a `X-Goog-Upload-URL: …` header.

## Recovery (SpejAI runs this after the GCP admin confirms #4 returns 200)

The doc(s) currently stuck in `failed` need to be flipped back to `pending` so
the analyze function picks them up via the redispatch watchdog (every 5 min).

Run against prod (`oopjlechxxbyisntbtvw`):

```sql
UPDATE claim_documents
SET processing_status = 'pending', processing_error = NULL
WHERE source = 'imageright'
  AND processing_error LIKE 'Failed to start Gemini upload: 403%';
```

Verify within 10 min:

```sql
SELECT id, processing_status, processing_error, updated_at
FROM claim_documents
WHERE source = 'imageright'
  AND id IN (SELECT id FROM claim_documents
             WHERE processing_error LIKE 'Failed to start Gemini upload: 403%'
             FOR UPDATE SKIP LOCKED);
```

Status should progress: `pending` → `processing` → `processed`. If a recovered
doc lands back in `failed` with a different error, it's a separate problem —
investigate that error code on its own.

## Out of scope for this handoff

- This isn't a Spej code bug. The retryable-vs-fatal classification at
  [supabase/functions/analyze-claim-document/index.ts:1367](../supabase/functions/analyze-claim-document/index.ts#L1367)
  treats 403 as fatal, which is correct — the watchdog only retries codes that
  classify as `pending`. A 403 should land in `failed` until IAM is fixed.
- Adding Files API auth scope as a separate token would not help — the existing
  `cloud-platform` scope already covers both endpoints. The blocker is IAM/API
  enablement on GCP, not OAuth scope.
