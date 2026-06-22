# Spej Claims Analyzer - System Architecture

## Overview

The Spej Claims Analyzer is an AI-powered insurance claims document review system. Adjusters upload claim documents (demand letters, medical records, bills), and the system uses Google Gemini to extract structured data, score completeness, and present findings for human review.

```mermaid
graph TB
    subgraph Frontend["Frontend (Vercel)"]
        UI[React + Vite + TypeScript]
        RQ[React Query]
        RT[Realtime Subscriptions]
    end

    subgraph Supabase["Supabase Platform"]
        Auth[Auth + MFA]
        DB[(PostgreSQL)]
        Storage[Storage Bucket]
        EF[Edge Functions - Deno]
        Realtime[Realtime Engine]
    end

    subgraph External["External Services"]
        Vertex[Google Vertex AI / Gemini]
        Resend[Resend Email API]
    end

    UI -->|Auth| Auth
    UI -->|CRUD| DB
    UI -->|Upload| Storage
    UI -->|Invoke| EF
    RT -->|WebSocket| Realtime
    Realtime -->|Changes| DB
    EF -->|Read/Write| DB
    EF -->|Download| Storage
    EF -->|Analyze| Vertex
    EF -->|Email| Resend
```

---

## Environments & CI/CD

Three environments with isolated Supabase projects and Vercel deployments:

```mermaid
graph LR
    subgraph Branches
        DEV[development]
        STG[stage]
        MAIN[main]
    end

    subgraph Vercel
        V_DEV[Development Preview]
        V_STG[Stage Preview]
        V_PROD[Production]
    end

    subgraph Supabase
        S_DEV[Spej Claims Analyzer - Dev]
        S_STG[Spej Claims Analyzer - Stage]
        S_PROD[Spej Claims Analyzer]
    end

    DEV -->|push| V_DEV
    DEV -->|push| S_DEV
    STG -->|push| V_STG
    STG -->|push| S_STG
    MAIN -->|push| V_PROD
    MAIN -->|push| S_PROD

    DEV -->|PR| STG
    STG -->|PR| MAIN
```

| Branch | Vercel Env | Supabase Project | Deploy Trigger |
|--------|-----------|------------------|----------------|
| `development` | Development | Spej Claims Analyzer - Dev | Push to branch |
| `stage` | Preview | Spej Claims Analyzer - Stage | PR merge from development |
| `main` | Production | Spej Claims Analyzer | PR merge from stage |

Each deploy workflow runs: build + test + Vercel deploy + Supabase migrations + edge function deploy.

---

## Frontend Architecture

**Stack:** React 18 + TypeScript + Vite + Tailwind CSS + shadcn/ui

```mermaid
graph TD
    App[App.tsx - Router]
    App --> AuthPage[/auth - Login/Signup]
    App --> ResetPw[/reset-password]
    App --> Index[/ - Claims Workspace]
    App --> Admin[/admin - User Management]
    App --> Settings[/settings - MFA/Account]

    Index --> CA[ClaimsAgent]
    Index --> CDP[ClaimDetailsPanel]
    Index --> CQ[ClaimsQueue]

    CA -->|Upload & Chat| EF_Analyze[analyze-claim-document]
    CA -->|AI Chat| EF_Chat[claims-chat]
    CA -->|Status| Hook_PS[useProcessingStatus]

    Hook_PS -->|WebSocket| RT_Jobs[processing_jobs channel]
    Hook_PS -->|WebSocket| RT_Logs[processing_logs channel]
```

**Key Components:**

| Component | Purpose |
|-----------|---------|
| `ClaimsAgent` | Core UI — file upload, document analysis trigger, AI chat interface |
| `ClaimDetailsPanel` | Editable sidebar showing extracted claim metadata |
| `ClaimsQueue` | List of pending/completed claims for review and approval |
| `ProcessingStatusCard` | Real-time progress bar and log viewer during analysis |
| `DemandReviewCard` | Displays extracted analysis results after processing |

**State Management:**

| Layer | Tool | Purpose |
|-------|------|---------|
| Server state | React Query (TanStack) | Cache & sync Supabase data |
| Auth state | `useAuth` hook | Session tracking via Supabase Auth |
| Role state | `useUserRole` hook | RBAC checks (`isAdmin`, `canApproveReject`) |
| Processing state | `ProcessingContext` | Track multi-step document processing pipeline |
| Real-time | `useProcessingStatus` hook | WebSocket subscriptions for job progress |

---

## Database Schema

```mermaid
erDiagram
    auth_users ||--o{ profiles : "has"
    auth_users ||--o{ user_roles : "has"
    claims ||--o{ claim_documents : "contains"
    claim_documents ||--o{ processing_jobs : "tracked by"
    claim_documents ||--o{ extraction_passes : "analyzed in"
    claim_documents ||--o{ document_analysis_results : "produces"
    processing_jobs ||--o{ processing_logs : "logged in"

    claims {
        uuid id PK
        text claim_number
        text claim_type
        text status
        text policy_number
        date incident_date
        text claimant_name
        uuid assigned_to FK
        uuid reviewed_by FK
        timestamptz reviewed_at
        jsonb claim_details
    }

    claim_documents {
        uuid id PK
        uuid claim_id FK
        text document_type
        text file_name
        text file_url
        int file_size
        text mime_type
        text processing_status
        jsonb ai_analysis
        jsonb ai_analysis_raw
        text ai_summary
        jsonb extracted_text
        numeric extraction_completeness
    }

    processing_jobs {
        uuid id PK
        uuid document_id FK
        text status
        int progress
        text current_step
        text error_message
        text error_code
        int retry_count
        int max_retries
        jsonb metadata
    }

    processing_logs {
        uuid id PK
        uuid job_id FK
        text level
        text message
        jsonb details
    }

    extraction_passes {
        uuid id PK
        uuid document_id FK
        int pass_number
        text fields_extracted
        numeric completeness_score
    }

    profiles {
        uuid id PK
        uuid user_id FK
        text full_name
        text department
        text avatar_url
    }

    user_roles {
        uuid id PK
        uuid user_id FK
        app_role role
    }
```

**Row-Level Security (RLS):**

All tables enforce RLS. Access is determined by the `has_role()` security definer function:

| Role | Claims | Documents | Jobs/Logs | Users |
|------|--------|-----------|-----------|-------|
| `admin` | All | All | All | Manage all |
| `claims_manager` | All | All | All | View only |
| `claims_reviewer` | Pending + assigned | Via claim access | Via document access | Own profile |

**Real-time Enabled Tables:** `claims`, `claim_documents`, `processing_jobs`, `processing_logs`

---

## Document Processing Pipeline

This is the core of the system — a multi-pass AI extraction pipeline with real-time progress tracking.

```mermaid
sequenceDiagram
    participant User
    participant Frontend
    participant Storage
    participant EdgeFn as Edge Function
    participant DB as PostgreSQL
    participant Gemini as Vertex AI / Gemini

    User->>Frontend: Upload document
    Frontend->>Storage: Upload file to claim-documents bucket
    Frontend->>DB: Create claim_documents record (status: pending)
    Frontend->>DB: RPC create_processing_job()
    Frontend->>EdgeFn: POST /analyze-claim-document

    Note over EdgeFn: Step 1: Download & Validate
    EdgeFn->>Storage: Download file
    EdgeFn->>DB: update_job_progress(10%)

    Note over EdgeFn: Step 2: Determine Processing Mode
    alt Large PDF (>20MB)
        EdgeFn->>Gemini: Upload via File API (resumable)
        EdgeFn->>Gemini: Poll until ACTIVE
    else Small PDF / Image
        EdgeFn->>EdgeFn: Convert to base64 inline
    end
    EdgeFn->>DB: update_job_progress(25%)

    Note over EdgeFn: Pass 1: Full Analysis
    EdgeFn->>Gemini: generateContent (extract all fields)
    Gemini-->>EdgeFn: Structured JSON response
    EdgeFn->>DB: Save extraction_passes record
    EdgeFn->>DB: update_job_progress(50%)

    Note over EdgeFn: Completeness Check
    EdgeFn->>EdgeFn: Score extraction (0.0 - 1.0)

    alt Completeness < 0.8
        Note over EdgeFn: Pass 2: Gap-Fill
        EdgeFn->>Gemini: Targeted extraction on weak fields
        Gemini-->>EdgeFn: Missing field data
        EdgeFn->>DB: update_job_progress(75%)
    end

    Note over EdgeFn: Pass 3: Validate & Merge
    EdgeFn->>EdgeFn: Deduplicate, aggregate, validate
    EdgeFn->>DB: update_job_progress(85%)

    Note over EdgeFn: Sync & Save
    EdgeFn->>DB: Update claims with extracted metadata
    EdgeFn->>DB: Update claim_documents (ai_analysis, ai_summary)
    EdgeFn->>DB: update_job_progress(100%, completed)

    alt File API used
        EdgeFn->>Gemini: Delete uploaded file
    end

    DB-->>Frontend: Real-time: job completed
    Frontend->>User: Show analysis results
```

**Processing Modes:**

| Mode | Condition | Method |
|------|-----------|--------|
| `gemini-file` | PDF > `GEMINI_FILE_API_THRESHOLD` + Gemini key configured | Upload to Gemini Files API, reference by `fileData` URI |
| `pdf-inline` | PDF ≤ threshold | Base64 encode, send inline |
| `vision-url` | Image files | Fetch + send image bytes inline |
| `text-fallback` | No Gemini key + large file | Text-only extraction |

**File Size Thresholds:**

| Threshold | Value | Purpose |
|-----------|-------|---------|
| `GEMINI_FILE_API_THRESHOLD` | 20 MB | Switch to File API upload |
| `STREAMING_THRESHOLD` | 40 MB | Stream from storage instead of buffering |
| `GEMINI_PDF_INFERENCE_LIMIT` | 50 MB | Max size Gemini can process |
| `PRO_MODEL_THRESHOLD` | 50 MB | Use gemini-2.5-pro instead of flash |
| `MAX_FILE_SIZE` | 300 MB | Hard upload limit |

---

## Edge Functions

```mermaid
graph TD
    subgraph "analyze-claim-document"
        A1[Download File] --> A2[Processing Mode Selection]
        A2 --> A3[Pass 1: Full Analysis]
        A3 --> A4[Completeness Scoring]
        A4 --> A5{Score ≥ 0.8?}
        A5 -->|No| A6[Pass 2: Gap-Fill]
        A6 --> A7[Pass 3: Validate & Merge]
        A5 -->|Yes| A7
        A7 --> A8[Sync Claim Details]
        A8 --> A9[Save Results]
    end

    subgraph Shared Modules
        gemini[gemini.ts - File API ops]
        vertex[vertex-auth.ts - Service account JWT]
        prompts[prompts.ts - AI prompts]
        schema[extraction-schema.ts - Field definitions]
        completeness[completeness.ts - Quality scoring]
        gapfill[gap-fill.ts - Targeted extraction]
        merge[merge.ts - Result merging]
        validation[validation.ts - Dedup & aggregate]
        job[job.ts - Progress tracking]
    end

    A2 --> gemini
    gemini --> vertex
    A3 --> prompts
    A3 --> schema
    A4 --> completeness
    A6 --> gapfill
    A7 --> validation
    A7 --> merge
    A1 --> job
```

| Function | Purpose | Integrations |
|----------|---------|-------------|
| `analyze-claim-document` | Multi-pass document analysis pipeline | Vertex AI (Gemini 2.5), Supabase DB & Storage |
| `claims-chat` | Conversational AI assistant for claim review | Lovable AI API |
| `send-password-reset` | Email password reset links | Resend Email API |

---

## Authentication & Authorization

```mermaid
graph TD
    Signup[User Signup] --> Auth[Supabase Auth]
    Auth --> Trigger[handle_new_user trigger]
    Trigger --> Profile[Create profiles record]
    Trigger --> Role[Assign claims_reviewer role]

    Login[User Login] --> Auth
    Auth --> MFA{MFA Enabled?}
    MFA -->|Yes| TOTP[Verify TOTP Code]
    MFA -->|No| Session[Create Session]
    TOTP --> Session

    Session --> RLS[RLS Policy Check]
    RLS --> HasRole[has_role function]
    HasRole --> Access{Authorized?}
    Access -->|Yes| Data[Return Data]
    Access -->|No| Denied[403 Denied]
```

**Roles:**

| Role | Permissions |
|------|-------------|
| `admin` | Full access — all claims, documents, user management |
| `claims_manager` | View all claims, approve/reject, no user management |
| `claims_reviewer` | View pending/assigned claims, submit for review |

New users are automatically assigned `claims_reviewer`. Admins manage roles via the Admin page.

---

## External Integrations

```mermaid
graph LR
    subgraph "Supabase Edge Functions"
        Analyze[analyze-claim-document]
        Chat[claims-chat]
        Reset[send-password-reset]
    end

    subgraph "Google Cloud"
        FileAPI[Gemini File API]
        VertexAI[Vertex AI - generateContent]
        OAuth[OAuth2 Token Exchange]
    end

    subgraph "Third Party"
        ResendAPI[Resend Email API]
    end

    Analyze -->|Upload/Poll/Delete| FileAPI
    Analyze -->|Generate Content| VertexAI
    Analyze -->|JWT → Token| OAuth
    Chat -->|Generate Content| VertexAI
    Chat -->|JWT → Token| OAuth
    Reset -->|Send Email| ResendAPI
```

| Service | Purpose | Auth Method |
|---------|---------|-------------|
| Google Gemini API (Gemini 2.5) | Document analysis, extraction, claims chat | API key (`GEMINI_API_KEY`, `x-goog-api-key`) |
| Gemini Files API | Large PDF upload/processing | API key (`GEMINI_API_KEY`) |
| Anthropic (Claude) | Pass 5 grounding / repair evaluation | API key (`ANTHROPIC_API_KEY`, `x-api-key`) |
| Resend | Password reset emails | API key (`RESEND_API_KEY`) |

---

## Storage

**Bucket:** `claim-documents` (Supabase Storage)

```
claim-documents/
  └── {uuid}/
      └── demand-letter.pdf
      └── medical-records.pdf
```

- Files uploaded from frontend with random UUID prefix
- Public read access for edge function processing
- File metadata stored in `claim_documents` table (`file_name`, `file_size`, `mime_type`, `file_url`)

---

## Environment Variables

### Frontend (Vercel)

| Variable | Purpose |
|----------|---------|
| `VITE_SUPABASE_PROJECT_ID` | Supabase project reference |
| `VITE_SUPABASE_URL` | Supabase API endpoint |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Supabase anon/public key |

### Edge Functions (Supabase Secrets)

| Variable | Purpose |
|----------|---------|
| `SUPABASE_URL` | Auto-provided by Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Auto-provided by Supabase |
| `GEMINI_API_KEY` | Google Gemini API key (analysis, extraction, claims chat) |
| `ANTHROPIC_API_KEY` | Anthropic API key (Pass 5 grounding) |
| `RESEND_API_KEY` | Resend email service |
