// Job progress tracking utilities

import { JobProgress } from './types.ts';
import { log } from './utils.ts';

export async function updateJobProgress(
  ctx: JobProgress,
  progress: number,
  currentStep: string,
  status?: 'processing' | 'completed' | 'failed',
  errorMessage?: string,
  errorCode?: string
) {
  try {
    const { error } = await ctx.supabase.rpc('update_job_progress' as never, {
      p_job_id: ctx.jobId,
      p_progress: progress,
      p_current_step: currentStep,
      p_status: status || null,
      p_error_message: errorMessage || null,
      p_error_code: errorCode || null,
    } as never);
    
    if (error) {
      log('WARN', 'JOB_PROGRESS', `Failed to update job progress: ${error.message}`);
    }
  } catch (err) {
    log('WARN', 'JOB_PROGRESS', `Error updating job progress: ${err}`);
  }
}

export async function addJobLog(
  ctx: JobProgress,
  level: 'info' | 'warn' | 'error' | 'debug',
  message: string,
  details?: Record<string, unknown>
) {
  try {
    const { error } = await ctx.supabase.rpc('add_processing_log' as never, {
      p_job_id: ctx.jobId,
      p_level: level,
      p_message: message,
      p_details: details || null,
    } as never);
    
    if (error) {
      log('WARN', 'JOB_LOG', `Failed to add job log: ${error.message}`);
    }
  } catch (err) {
    log('WARN', 'JOB_LOG', `Error adding job log: ${err}`);
  }
}

export async function createProcessingJob(supabase: any, documentId: string): Promise<string | null> {
  try {
    const { data, error } = await supabase.rpc('create_processing_job' as never, {
      p_document_id: documentId,
    } as never);
    
    if (error) {
      log('ERROR', 'JOB_CREATE', `Failed to create processing job: ${error.message}`);
      return null;
    }
    
    log('INFO', 'JOB_CREATE', `Created processing job: ${data}`);
    return data as string;
  } catch (err) {
    log('ERROR', 'JOB_CREATE', `Error creating processing job: ${err}`);
    return null;
  }
}
