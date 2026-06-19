import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { RealtimeChannel } from '@supabase/supabase-js';

export interface ProcessingJob {
  id: string;
  document_id: string;
  status: 'pending' | 'queued' | 'processing' | 'completed' | 'failed';
  progress: number;
  current_step: string | null;
  error_message: string | null;
  error_code: string | null;
  retry_count: number;
  max_retries: number;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown>;
}

export interface ProcessingLog {
  id: string;
  job_id: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  details: Record<string, unknown> | null;
  created_at: string;
}

interface UseProcessingStatusResult {
  job: ProcessingJob | null;
  logs: ProcessingLog[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

export function useProcessingStatus(documentId: string | null): UseProcessingStatusResult {
  const [job, setJob] = useState<ProcessingJob | null>(null);
  const [logs, setLogs] = useState<ProcessingLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchJob = useCallback(async () => {
    if (!documentId) {
      setJob(null);
      setLogs([]);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const { data: jobData, error: jobError } = await supabase
        .from('processing_jobs')
        .select('*')
        .eq('document_id', documentId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (jobError) throw jobError;
      
      if (jobData) {
        setJob(jobData as ProcessingJob);

        const { data: logsData, error: logsError } = await supabase
          .from('processing_logs')
          .select('*')
          .eq('job_id', jobData.id)
          .order('created_at', { ascending: true });

        if (logsError) throw logsError;
        setLogs((logsData as ProcessingLog[]) || []);
      } else {
        setJob(null);
        setLogs([]);
      }
    } catch (err) {
      console.error('Error fetching processing status:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch processing status');
    } finally {
      setLoading(false);
    }
  }, [documentId]);

  useEffect(() => {
    fetchJob();
  }, [fetchJob]);

  useEffect(() => {
    if (!documentId) return;

    let jobChannel: RealtimeChannel | null = null;
    let logsChannel: RealtimeChannel | null = null;

    const setupSubscriptions = async () => {
      const { data: jobData } = await supabase
        .from('processing_jobs')
        .select('id')
        .eq('document_id', documentId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      jobChannel = supabase
        .channel(`processing-job-${documentId}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'processing_jobs',
            filter: `document_id=eq.${documentId}`,
          },
          (payload) => {
            if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
              setJob(payload.new as ProcessingJob);
            } else if (payload.eventType === 'DELETE') {
              setJob(null);
              setLogs([]);
            }
          }
        )
        .subscribe();

      if (jobData?.id) {
        logsChannel = supabase
          .channel(`processing-logs-${jobData.id}`)
          .on(
            'postgres_changes',
            {
              event: 'INSERT',
              schema: 'public',
              table: 'processing_logs',
              filter: `job_id=eq.${jobData.id}`,
            },
            (payload) => {
              setLogs((prev) => [...prev, payload.new as ProcessingLog]);
            }
          )
          .subscribe();
      }
    };

    setupSubscriptions();

    return () => {
      if (jobChannel) supabase.removeChannel(jobChannel);
      if (logsChannel) supabase.removeChannel(logsChannel);
    };
  }, [documentId]);

  return { job, logs, loading, error, refetch: fetchJob };
}

export const ERROR_CODES = {
  TIMEOUT: { retryable: true, description: 'Request timed out' },
  GEMINI_503: { retryable: true, description: 'AI service temporarily unavailable' },
  GEMINI_RATE_LIMIT: { retryable: true, description: 'Rate limit exceeded' },
  DOWNLOAD_FAILED: { retryable: true, description: 'Failed to download file' },
  INVALID_FILE: { retryable: false, description: 'Invalid or corrupt file' },
  AI_CREDITS_EXHAUSTED: { retryable: false, description: 'AI credits exhausted' },
  PARSE_ERROR: { retryable: false, description: 'Failed to parse AI response' },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export function isRetryableError(errorCode: string | null): boolean {
  if (!errorCode) return false;
  const config = ERROR_CODES[errorCode as ErrorCode];
  return config?.retryable ?? false;
}
