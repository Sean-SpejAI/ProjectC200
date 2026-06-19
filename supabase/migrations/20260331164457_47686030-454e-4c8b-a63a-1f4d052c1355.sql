
-- Create claims table
CREATE TABLE public.claims (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  claim_number TEXT NOT NULL,
  claim_type TEXT NOT NULL DEFAULT 'auto',
  status TEXT NOT NULL DEFAULT 'pending',
  policy_number TEXT,
  incident_date DATE,
  incident_description TEXT,
  claimant_name TEXT,
  claimant_email TEXT,
  claimant_phone TEXT,
  accident_location TEXT,
  assigned_to UUID REFERENCES auth.users(id),
  reviewed_by UUID REFERENCES auth.users(id),
  reviewed_at TIMESTAMP WITH TIME ZONE,
  review_notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create claim_documents table
CREATE TABLE public.claim_documents (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  claim_id UUID NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL DEFAULT 'other',
  file_name TEXT NOT NULL,
  file_url TEXT NOT NULL,
  file_size INTEGER,
  mime_type TEXT,
  ai_summary TEXT,
  ai_analysis JSONB,
  ai_analysis_raw JSONB,
  correspondence_status TEXT DEFAULT 'pending',
  correspondence_notes TEXT,
  processing_status TEXT NOT NULL DEFAULT 'pending',
  processing_error TEXT,
  processing_started_at TIMESTAMP WITH TIME ZONE,
  claim_details JSONB,
  extracted_text JSONB,
  extraction_completeness DECIMAL(3,2),
  uploaded_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  analyzed_at TIMESTAMP WITH TIME ZONE
);

-- Create document_analysis_results table
CREATE TABLE public.document_analysis_results (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES public.claim_documents(id) ON DELETE CASCADE,
  analysis_type TEXT NOT NULL,
  extracted_data JSONB,
  confidence_score DECIMAL(3,2),
  flags TEXT[],
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create app_role enum
CREATE TYPE public.app_role AS ENUM ('admin', 'claims_reviewer', 'claims_manager');

-- Create user_roles table
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  role app_role NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);

-- Create profiles table
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  full_name TEXT,
  department TEXT DEFAULT 'Claims',
  avatar_url TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create processing_jobs table
CREATE TABLE public.processing_jobs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES public.claim_documents(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  progress INTEGER NOT NULL DEFAULT 0,
  current_step TEXT,
  error_message TEXT,
  error_code TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  metadata JSONB DEFAULT '{}'::jsonb
);

-- Create processing_logs table
CREATE TABLE public.processing_logs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES public.processing_jobs(id) ON DELETE CASCADE,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  details JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create extraction_passes table
CREATE TABLE public.extraction_passes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES public.claim_documents(id) ON DELETE CASCADE,
  pass_number INT NOT NULL,
  fields_extracted TEXT[],
  completeness_score DECIMAL(3,2),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS on all tables
ALTER TABLE public.claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_analysis_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.processing_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.processing_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.extraction_passes ENABLE ROW LEVEL SECURITY;

-- Create security definer function for role checks
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role app_role)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;

-- Create update_updated_at function
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

-- Create triggers for timestamp updates
CREATE TRIGGER update_claims_updated_at BEFORE UPDATE ON public.claims FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_processing_jobs_updated_at BEFORE UPDATE ON public.processing_jobs FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Handle new user signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (user_id, full_name) VALUES (NEW.id, NEW.raw_user_meta_data->>'full_name');
  INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'claims_reviewer');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- RLS Policies for profiles
CREATE POLICY "Users can view their own profile" ON public.profiles FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Admins can view all profiles" ON public.profiles FOR SELECT USING (has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Users can update their own profile" ON public.profiles FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can insert their own profile" ON public.profiles FOR INSERT WITH CHECK (auth.uid() = user_id);

-- RLS Policies for user_roles
CREATE POLICY "Users can view their own roles" ON public.user_roles FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Admins can view all user roles" ON public.user_roles FOR SELECT TO authenticated USING (has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins can insert user roles" ON public.user_roles FOR INSERT TO authenticated WITH CHECK (has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins can delete user roles" ON public.user_roles FOR DELETE TO authenticated USING (has_role(auth.uid(), 'admin'));

-- RLS Policies for claims
CREATE POLICY "Admins can view all claims" ON public.claims FOR SELECT TO authenticated USING (has_role(auth.uid(), 'admin'));
CREATE POLICY "Claims managers can view all claims" ON public.claims FOR SELECT USING (has_role(auth.uid(), 'claims_manager'::app_role));
CREATE POLICY "Claims reviewers can view pending claims" ON public.claims FOR SELECT USING (status IN ('pending', 'in_review') AND has_role(auth.uid(), 'claims_reviewer'::app_role));
CREATE POLICY "Users can view their assigned claims" ON public.claims FOR SELECT TO authenticated USING (assigned_to = auth.uid() OR reviewed_by = auth.uid());
CREATE POLICY "Admins and managers can insert claims" ON public.claims FOR INSERT TO authenticated WITH CHECK (has_role(auth.uid(), 'admin') OR has_role(auth.uid(), 'claims_manager'));
CREATE POLICY "Claims reviewers can insert claims" ON public.claims FOR INSERT TO authenticated WITH CHECK (has_role(auth.uid(), 'claims_reviewer'::app_role) AND assigned_to = auth.uid());
CREATE POLICY "Users can update their assigned claims" ON public.claims FOR UPDATE TO authenticated USING (assigned_to = auth.uid() OR has_role(auth.uid(), 'admin') OR has_role(auth.uid(), 'claims_manager'));
CREATE POLICY "Users can delete their assigned claims" ON public.claims FOR DELETE USING (assigned_to = auth.uid() OR has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'claims_manager'::app_role));
CREATE POLICY "Claims reviewers can delete pending claims" ON public.claims FOR DELETE USING (status IN ('pending', 'in_review') AND has_role(auth.uid(), 'claims_reviewer'::app_role));

-- RLS Policies for claim_documents
CREATE POLICY "Admins can view all documents" ON public.claim_documents FOR SELECT TO authenticated USING (has_role(auth.uid(), 'admin'));
CREATE POLICY "Users can view documents for their claims" ON public.claim_documents FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.claims WHERE claims.id = claim_documents.claim_id AND (claims.assigned_to = auth.uid() OR claims.reviewed_by = auth.uid())));
CREATE POLICY "Users can insert documents for their claims" ON public.claim_documents FOR INSERT TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM public.claims WHERE claims.id = claim_documents.claim_id AND (claims.assigned_to = auth.uid() OR has_role(auth.uid(), 'admin'))));
CREATE POLICY "Users can update documents for their claims" ON public.claim_documents FOR UPDATE TO authenticated USING (EXISTS (SELECT 1 FROM public.claims WHERE claims.id = claim_documents.claim_id AND (claims.assigned_to = auth.uid() OR has_role(auth.uid(), 'admin'))));
CREATE POLICY "Users can delete documents for their claims" ON public.claim_documents FOR DELETE USING (EXISTS (SELECT 1 FROM claims WHERE claims.id = claim_documents.claim_id AND (claims.assigned_to = auth.uid() OR has_role(auth.uid(), 'admin'::app_role))));

-- RLS Policies for document_analysis_results
CREATE POLICY "Admins can view all analysis results" ON public.document_analysis_results FOR SELECT TO authenticated USING (has_role(auth.uid(), 'admin'));
CREATE POLICY "Users can view analysis for their claims" ON public.document_analysis_results FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.claim_documents cd JOIN public.claims c ON c.id = cd.claim_id WHERE cd.id = document_analysis_results.document_id AND (c.assigned_to = auth.uid() OR c.reviewed_by = auth.uid())));
CREATE POLICY "Users can insert analysis for their claims" ON public.document_analysis_results FOR INSERT TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM public.claim_documents cd JOIN public.claims c ON c.id = cd.claim_id WHERE cd.id = document_analysis_results.document_id AND (c.assigned_to = auth.uid() OR has_role(auth.uid(), 'admin'))));
CREATE POLICY "Users can delete analysis for their claims" ON public.document_analysis_results FOR DELETE USING (EXISTS (SELECT 1 FROM claim_documents cd JOIN claims c ON c.id = cd.claim_id WHERE cd.id = document_analysis_results.document_id AND (c.assigned_to = auth.uid() OR has_role(auth.uid(), 'admin'::app_role))));

-- RLS Policies for processing_jobs
CREATE POLICY "Users can view their processing jobs" ON public.processing_jobs FOR SELECT USING (EXISTS (SELECT 1 FROM public.claim_documents cd JOIN public.claims c ON c.id = cd.claim_id WHERE cd.id = processing_jobs.document_id AND (c.assigned_to = auth.uid() OR c.reviewed_by = auth.uid())));
CREATE POLICY "Admins can view all processing jobs" ON public.processing_jobs FOR SELECT USING (has_role(auth.uid(), 'admin'::app_role));

-- RLS Policies for processing_logs
CREATE POLICY "Users can view their processing logs" ON public.processing_logs FOR SELECT USING (EXISTS (SELECT 1 FROM public.processing_jobs pj JOIN public.claim_documents cd ON cd.id = pj.document_id JOIN public.claims c ON c.id = cd.claim_id WHERE pj.id = processing_logs.job_id AND (c.assigned_to = auth.uid() OR c.reviewed_by = auth.uid())));
CREATE POLICY "Admins can view all processing logs" ON public.processing_logs FOR SELECT USING (has_role(auth.uid(), 'admin'::app_role));

-- RLS Policies for extraction_passes
CREATE POLICY "Users can view extraction passes for their claims" ON public.extraction_passes FOR SELECT USING (EXISTS (SELECT 1 FROM claim_documents cd JOIN claims c ON c.id = cd.claim_id WHERE cd.id = extraction_passes.document_id AND (c.assigned_to = auth.uid() OR c.reviewed_by = auth.uid())));
CREATE POLICY "Admins can view all extraction passes" ON public.extraction_passes FOR SELECT USING (has_role(auth.uid(), 'admin'::app_role));

-- Storage bucket
INSERT INTO storage.buckets (id, name, public) VALUES ('claim-documents', 'claim-documents', true) ON CONFLICT (id) DO NOTHING;
CREATE POLICY "Allow public upload to claim-documents" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'claim-documents');
CREATE POLICY "Allow public read from claim-documents" ON storage.objects FOR SELECT USING (bucket_id = 'claim-documents');

-- Enable realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.claims;
ALTER PUBLICATION supabase_realtime ADD TABLE public.claim_documents;
ALTER PUBLICATION supabase_realtime ADD TABLE public.processing_jobs;
ALTER PUBLICATION supabase_realtime ADD TABLE public.processing_logs;

-- Indexes
CREATE INDEX idx_claim_documents_processing_status ON public.claim_documents(processing_status) WHERE processing_status IN ('pending', 'processing');
CREATE INDEX idx_processing_jobs_document_id ON public.processing_jobs(document_id);
CREATE INDEX idx_processing_jobs_status ON public.processing_jobs(status);
CREATE INDEX idx_processing_logs_job_id ON public.processing_logs(job_id);
CREATE INDEX idx_extraction_passes_document_id ON public.extraction_passes(document_id);

-- RPC functions for processing jobs
CREATE OR REPLACE FUNCTION public.update_job_progress(p_job_id UUID, p_progress INTEGER, p_current_step TEXT DEFAULT NULL, p_status TEXT DEFAULT NULL, p_error_message TEXT DEFAULT NULL, p_error_code TEXT DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.processing_jobs SET progress = p_progress, current_step = COALESCE(p_current_step, current_step), status = COALESCE(p_status, status), error_message = COALESCE(p_error_message, error_message), error_code = COALESCE(p_error_code, error_code), started_at = CASE WHEN p_status = 'processing' AND started_at IS NULL THEN now() ELSE started_at END, completed_at = CASE WHEN p_status IN ('completed', 'failed') THEN now() ELSE completed_at END, updated_at = now() WHERE id = p_job_id;
END; $$;

CREATE OR REPLACE FUNCTION public.add_processing_log(p_job_id UUID, p_level TEXT, p_message TEXT, p_details JSONB DEFAULT NULL)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_log_id UUID;
BEGIN INSERT INTO public.processing_logs (job_id, level, message, details) VALUES (p_job_id, p_level, p_message, p_details) RETURNING id INTO v_log_id; RETURN v_log_id; END; $$;

CREATE OR REPLACE FUNCTION public.create_processing_job(p_document_id UUID)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job_id UUID;
BEGIN INSERT INTO public.processing_jobs (document_id, status, current_step) VALUES (p_document_id, 'queued', 'Initializing...') RETURNING id INTO v_job_id; RETURN v_job_id; END; $$;
