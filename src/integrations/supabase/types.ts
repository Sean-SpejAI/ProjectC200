export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.4"
  }
  public: {
    Tables: {
      claim_documents: {
        Row: {
          ai_analysis: Json | null
          ai_analysis_raw: Json | null
          ai_summary: string | null
          analyzed_at: string | null
          claim_details: Json | null
          claim_id: string
          correspondence_notes: string | null
          correspondence_status: string | null
          document_type: string
          extracted_text: Json | null
          extraction_completeness: number | null
          file_name: string
          file_size: number | null
          file_url: string
          grounding_status: string
          id: string
          imageright_document_date: string | null
          imageright_document_id: number | null
          imageright_document_type_code: string | null
          imageright_folder_id: number | null
          imageright_folder_name: string | null
          imageright_folder_path: Json | null
          imageright_page_count: number | null
          imageright_pages: Json | null
          imageright_processing_tier: string | null
          imageright_removed_at: string | null
          mime_type: string | null
          processing_error: string | null
          processing_started_at: string | null
          processing_status: string
          source: string
          uploaded_at: string
        }
        Insert: {
          ai_analysis?: Json | null
          ai_analysis_raw?: Json | null
          ai_summary?: string | null
          analyzed_at?: string | null
          claim_details?: Json | null
          claim_id: string
          correspondence_notes?: string | null
          correspondence_status?: string | null
          document_type?: string
          extracted_text?: Json | null
          extraction_completeness?: number | null
          file_name: string
          file_size?: number | null
          file_url: string
          grounding_status?: string
          id?: string
          imageright_document_date?: string | null
          imageright_document_id?: number | null
          imageright_document_type_code?: string | null
          imageright_folder_id?: number | null
          imageright_folder_name?: string | null
          imageright_folder_path?: Json | null
          imageright_page_count?: number | null
          imageright_pages?: Json | null
          imageright_processing_tier?: string | null
          imageright_removed_at?: string | null
          mime_type?: string | null
          processing_error?: string | null
          processing_started_at?: string | null
          processing_status?: string
          source?: string
          uploaded_at?: string
        }
        Update: {
          ai_analysis?: Json | null
          ai_analysis_raw?: Json | null
          ai_summary?: string | null
          analyzed_at?: string | null
          claim_details?: Json | null
          claim_id?: string
          correspondence_notes?: string | null
          correspondence_status?: string | null
          document_type?: string
          extracted_text?: Json | null
          extraction_completeness?: number | null
          file_name?: string
          file_size?: number | null
          file_url?: string
          grounding_status?: string
          id?: string
          imageright_document_date?: string | null
          imageright_document_id?: number | null
          imageright_document_type_code?: string | null
          imageright_folder_id?: number | null
          imageright_folder_name?: string | null
          imageright_folder_path?: Json | null
          imageright_page_count?: number | null
          imageright_pages?: Json | null
          imageright_processing_tier?: string | null
          imageright_removed_at?: string | null
          mime_type?: string | null
          processing_error?: string | null
          processing_started_at?: string | null
          processing_status?: string
          source?: string
          uploaded_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "claim_documents_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_field_audit: {
        Row: {
          changed_at: string
          changed_by: string | null
          changed_by_kind: string
          claim_id: string
          field_label: string | null
          field_path: string
          id: string
          new_value: Json | null
          old_value: Json | null
        }
        Insert: {
          changed_at?: string
          changed_by?: string | null
          changed_by_kind?: string
          claim_id: string
          field_label?: string | null
          field_path: string
          id?: string
          new_value?: Json | null
          old_value?: Json | null
        }
        Update: {
          changed_at?: string
          changed_by?: string | null
          changed_by_kind?: string
          claim_id?: string
          field_label?: string | null
          field_path?: string
          id?: string
          new_value?: Json | null
          old_value?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "claim_field_audit_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claims: {
        Row: {
          accident_location: string | null
          assigned_to: string | null
          claim_number: string
          claim_type: string
          claimant_email: string | null
          claimant_name: string | null
          claimant_phone: string | null
          created_at: string
          id: string
          incident_date: string | null
          incident_description: string | null
          policy_number: string | null
          review_notes: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          pending_reconcile: Json | null
          synthesis_human_edited_at: string | null
          synthesis_human_edited_by: string | null
          updated_at: string
        }
        Insert: {
          accident_location?: string | null
          assigned_to?: string | null
          claim_number: string
          claim_type?: string
          claimant_email?: string | null
          claimant_name?: string | null
          claimant_phone?: string | null
          created_at?: string
          id?: string
          incident_date?: string | null
          incident_description?: string | null
          policy_number?: string | null
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          pending_reconcile?: Json | null
          synthesis_human_edited_at?: string | null
          synthesis_human_edited_by?: string | null
          updated_at?: string
        }
        Update: {
          accident_location?: string | null
          assigned_to?: string | null
          claim_number?: string
          claim_type?: string
          claimant_email?: string | null
          claimant_name?: string | null
          claimant_phone?: string | null
          created_at?: string
          id?: string
          incident_date?: string | null
          incident_description?: string | null
          policy_number?: string | null
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          pending_reconcile?: Json | null
          synthesis_human_edited_at?: string | null
          synthesis_human_edited_by?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      document_analysis_results: {
        Row: {
          analysis_type: string
          confidence_score: number | null
          created_at: string
          document_id: string
          extracted_data: Json | null
          flags: string[] | null
          id: string
        }
        Insert: {
          analysis_type: string
          confidence_score?: number | null
          created_at?: string
          document_id: string
          extracted_data?: Json | null
          flags?: string[] | null
          id?: string
        }
        Update: {
          analysis_type?: string
          confidence_score?: number | null
          created_at?: string
          document_id?: string
          extracted_data?: Json | null
          flags?: string[] | null
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "document_analysis_results_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "claim_documents"
            referencedColumns: ["id"]
          },
        ]
      }
      extraction_passes: {
        Row: {
          completeness_score: number | null
          created_at: string | null
          document_id: string
          fields_extracted: string[] | null
          id: string
          pass_number: number
        }
        Insert: {
          completeness_score?: number | null
          created_at?: string | null
          document_id: string
          fields_extracted?: string[] | null
          id?: string
          pass_number: number
        }
        Update: {
          completeness_score?: number | null
          created_at?: string | null
          document_id?: string
          fields_extracted?: string[] | null
          id?: string
          pass_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "extraction_passes_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "claim_documents"
            referencedColumns: ["id"]
          },
        ]
      }
      processing_jobs: {
        Row: {
          completed_at: string | null
          created_at: string
          current_step: string | null
          document_id: string
          error_code: string | null
          error_message: string | null
          id: string
          max_retries: number
          metadata: Json | null
          progress: number
          retry_count: number
          started_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          current_step?: string | null
          document_id: string
          error_code?: string | null
          error_message?: string | null
          id?: string
          max_retries?: number
          metadata?: Json | null
          progress?: number
          retry_count?: number
          started_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          current_step?: string | null
          document_id?: string
          error_code?: string | null
          error_message?: string | null
          id?: string
          max_retries?: number
          metadata?: Json | null
          progress?: number
          retry_count?: number
          started_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "processing_jobs_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "claim_documents"
            referencedColumns: ["id"]
          },
        ]
      }
      processing_logs: {
        Row: {
          created_at: string
          details: Json | null
          id: string
          job_id: string
          level: string
          message: string
        }
        Insert: {
          created_at?: string
          details?: Json | null
          id?: string
          job_id: string
          level?: string
          message: string
        }
        Update: {
          created_at?: string
          details?: Json | null
          id?: string
          job_id?: string
          level?: string
          message?: string
        }
        Relationships: [
          {
            foreignKeyName: "processing_logs_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "processing_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          department: string | null
          full_name: string | null
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          department?: string | null
          full_name?: string | null
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          department?: string | null
          full_name?: string | null
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      add_processing_log: {
        Args: {
          p_details?: Json
          p_job_id: string
          p_level: string
          p_message: string
        }
        Returns: string
      }
      create_processing_job: {
        Args: { p_document_id: string }
        Returns: string
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      update_job_progress: {
        Args: {
          p_current_step?: string
          p_error_code?: string
          p_error_message?: string
          p_job_id: string
          p_progress: number
          p_status?: string
        }
        Returns: undefined
      }
    }
    Enums: {
      app_role: "admin" | "claims_reviewer" | "claims_manager"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "claims_reviewer", "claims_manager"],
    },
  },
} as const
