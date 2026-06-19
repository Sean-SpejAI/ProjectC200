import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MermaidChart } from "./MermaidChart";

// Processing Flow - shows the step-by-step document analysis pipeline
const processingFlowDiagram = `graph TD
    A[📄 Document Upload] --> B{Validate File}
    B -->|Valid| C[Store in Supabase Storage]
    B -->|Invalid| X[❌ Reject & Notify User]
    C --> D[Categorize Document Type]
    D --> E{File Size Check}
    E -->|≤5MB| F[Vision Analysis with Base64]
    E -->|>5MB| G[Text-Only Analysis]
    F --> H[🤖 AI Processing - Gemini 2.5 Flash]
    G --> H
    H --> I[Extract Key Information]
    I --> J[Generate Summary]
    J --> K[Verify Against Claim]
    K --> L[Save to Supabase Database]
    L --> M[✅ Update UI with Findings]
    
    style A fill:#1e40af,stroke:#1e3a8a,color:#fff,stroke-width:2px
    style B fill:#374151,stroke:#1f2937,color:#fff
    style C fill:#3ecf8e,stroke:#2da771,color:#1f2937,stroke-width:2px
    style D fill:#1e40af,stroke:#1e3a8a,color:#fff,stroke-width:2px
    style E fill:#374151,stroke:#1f2937,color:#fff
    style F fill:#6d28d9,stroke:#5b21b6,color:#fff,stroke-width:2px
    style G fill:#6d28d9,stroke:#5b21b6,color:#fff,stroke-width:2px
    style H fill:#7c3aed,stroke:#6d28d9,color:#fff,stroke-width:2px
    style I fill:#1e40af,stroke:#1e3a8a,color:#fff,stroke-width:2px
    style J fill:#1e40af,stroke:#1e3a8a,color:#fff,stroke-width:2px
    style K fill:#1e40af,stroke:#1e3a8a,color:#fff,stroke-width:2px
    style L fill:#3ecf8e,stroke:#2da771,color:#1f2937,stroke-width:2px
    style M fill:#15803d,stroke:#166534,color:#fff,stroke-width:2px
    style X fill:#dc2626,stroke:#b91c1c,color:#fff,stroke-width:2px`;

// System Architecture - shows high-level component relationships
const architectureDiagram = `graph LR
    subgraph FE["🖥️ FRONTEND - React"]
        direction TB
        UI["Claims Agent UI"]
        QU["Claims Queue"]
        DP["Details Panel"]
        LV["Logic View"]
    end
    
    subgraph SB["⚡ SUPABASE"]
        direction TB
        subgraph EF["Edge Functions"]
            AN["analyze-claim-document"]
            CH["claims-chat"]
        end
        AU["🔐 Auth"]
        ST["📦 Storage"]
        DB["🗄️ Database"]
    end
    
    subgraph AIS["🤖 AI"]
        GE["Gemini 2.5 Flash"]
    end
    
    UI --> AN
    UI --> CH
    UI --> ST
    AN --> GE
    CH --> GE
    AN --> DB
    AU --> DB
    
    style FE fill:#1d4ed8,stroke:#1e3a8a,stroke-width:3px,color:#fff
    style SB fill:#3ecf8e,stroke:#2da771,stroke-width:3px,color:#1f2937
    style AIS fill:#059669,stroke:#047857,stroke-width:3px,color:#fff
    style EF fill:#24b47e,stroke:#1a9163,stroke-width:2px,color:#1f2937
    
    style UI fill:#2563eb,stroke:#1d4ed8,stroke-width:2px,color:#fff
    style QU fill:#2563eb,stroke:#1d4ed8,stroke-width:2px,color:#fff
    style DP fill:#2563eb,stroke:#1d4ed8,stroke-width:2px,color:#fff
    style LV fill:#2563eb,stroke:#1d4ed8,stroke-width:2px,color:#fff
    
    style AN fill:#1a9163,stroke:#147a52,stroke-width:2px,color:#fff
    style CH fill:#1a9163,stroke:#147a52,stroke-width:2px,color:#fff
    style AU fill:#24b47e,stroke:#1a9163,stroke-width:2px,color:#1f2937
    style ST fill:#24b47e,stroke:#1a9163,stroke-width:2px,color:#1f2937
    style DB fill:#24b47e,stroke:#1a9163,stroke-width:2px,color:#1f2937
    
    style GE fill:#10b981,stroke:#059669,stroke-width:2px,color:#fff`;

// Data Flow - shows database entity relationships (unique to this tab)
const dataFlowDiagram = `erDiagram
    USERS ||--o{ PROFILES : has
    USERS ||--o{ USER_ROLES : has
    USERS ||--o{ CLAIMS : creates
    CLAIMS ||--o{ CLAIM_DOCUMENTS : contains
    CLAIM_DOCUMENTS ||--o{ DOCUMENT_ANALYSIS : generates
    
    USERS {
        uuid id PK
        string email
        timestamp created_at
    }
    
    PROFILES {
        uuid id PK
        uuid user_id FK
        string full_name
        string avatar_url
    }
    
    USER_ROLES {
        uuid id PK
        uuid user_id FK
        enum role
    }
    
    CLAIMS {
        uuid id PK
        string claim_number
        string claim_type
        date incident_date
        string status
        uuid assigned_to FK
    }
    
    CLAIM_DOCUMENTS {
        uuid id PK
        uuid claim_id FK
        string file_name
        string document_type
        string storage_path
    }
    
    DOCUMENT_ANALYSIS {
        uuid id PK
        uuid document_id FK
        jsonb analysis_data
        string verification_status
    }`;

// Approval workflow - unique state diagram
const approvalWorkflowDiagram = `stateDiagram-v2
    [*] --> Submitted
    Submitted --> InReview: Assign Reviewer
    InReview --> NeedsInfo: Request Documents
    NeedsInfo --> InReview: Documents Received
    InReview --> Approved: Low Risk
    InReview --> Escalated: High Risk
    Escalated --> ManagerReview
    ManagerReview --> Approved
    ManagerReview --> Denied
    Approved --> [*]
    Denied --> [*]`;

// Role permissions - unique hierarchy diagram
const rolesDiagram = `graph TD
    Admin["👑 ADMIN"] --> Manager["👔 MANAGER"]
    Admin --> Approver["✅ APPROVER"]
    Admin --> Analyst["🔍 ANALYST"]
    Manager --> Approver
    Manager --> Analyst
    
    Admin -.->|Full Access| All[All Actions]
    Manager -.->|Team Management| Team[Manage Team + Approve]
    Approver -.->|Approval Rights| Approve[View + Approve/Deny]
    Analyst -.->|Read Only| View[View + Analyze Only]
    
    style Admin fill:#dc2626,stroke:#b91c1c,color:#fff,stroke-width:2px
    style Manager fill:#ea580c,stroke:#c2410c,color:#fff,stroke-width:2px
    style Approver fill:#15803d,stroke:#166534,color:#fff,stroke-width:2px
    style Analyst fill:#1e40af,stroke:#1e3a8a,color:#fff,stroke-width:2px
    style All fill:#374151,stroke:#1f2937,color:#fff
    style Team fill:#374151,stroke:#1f2937,color:#fff
    style Approve fill:#374151,stroke:#1f2937,color:#fff
    style View fill:#374151,stroke:#1f2937,color:#fff`;

export function ArchitectureDiagram() {
  return (
    <div className="flex-1 p-4 md:p-6 overflow-auto bg-muted/30">
      <div className="max-w-6xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">System Architecture</h1>
          <p className="text-muted-foreground">Visual overview of the claims processing system</p>
        </div>

        <Tabs defaultValue="flow" className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="flow">Processing Flow</TabsTrigger>
            <TabsTrigger value="architecture">System Components</TabsTrigger>
            <TabsTrigger value="data">Database Schema</TabsTrigger>
          </TabsList>

          <TabsContent value="flow" className="mt-4 space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Document Processing Pipeline</CardTitle>
                <p className="text-sm text-muted-foreground">Step-by-step flow from upload to analysis completion</p>
              </CardHeader>
              <CardContent className="bg-slate-50 rounded-lg">
                <MermaidChart chart={processingFlowDiagram} />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="architecture" className="mt-4 space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">System Components</CardTitle>
                <p className="text-sm text-muted-foreground">High-level view of frontend, Supabase backend, and AI services</p>
              </CardHeader>
              <CardContent className="bg-slate-50 rounded-lg">
                <MermaidChart chart={architectureDiagram} />
              </CardContent>
            </Card>
            
            {/* Role permissions - fits better with system architecture */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Role Permissions Hierarchy</CardTitle>
                <p className="text-sm text-muted-foreground">User roles and their access levels</p>
              </CardHeader>
              <CardContent className="bg-slate-50 rounded-lg">
                <MermaidChart chart={rolesDiagram} />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="data" className="mt-4 space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Database Entity Relationships</CardTitle>
                <p className="text-sm text-muted-foreground">Supabase PostgreSQL database schema</p>
              </CardHeader>
              <CardContent className="bg-slate-50 rounded-lg">
                <MermaidChart chart={dataFlowDiagram} />
              </CardContent>
            </Card>
            
            {/* Approval workflow - fits better with data/state flow */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Claims State Machine</CardTitle>
                <p className="text-sm text-muted-foreground">Claim lifecycle from submission to resolution</p>
              </CardHeader>
              <CardContent className="bg-slate-50 rounded-lg">
                <MermaidChart chart={approvalWorkflowDiagram} />
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
