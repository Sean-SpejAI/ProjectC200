import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Icon } from '@/components/Icon';
import { cn } from '@/lib/utils';
import { ProcessingJob, ProcessingLog, isRetryableError } from '@/hooks/useProcessingStatus';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';

interface ProcessingStatusCardProps {
  job: ProcessingJob | null;
  logs: ProcessingLog[];
  fileName?: string;
  onRetry?: () => void;
  className?: string;
}

const STATUS_CONFIG = {
  pending: { icon: 'schedule', color: 'text-on-surface-variant', bg: 'bg-surface-container-low', label: 'Pending', animate: false },
  queued: { icon: 'schedule', color: 'text-info', bg: 'bg-info/10', label: 'Queued', animate: false },
  processing: { icon: 'progress_activity', color: 'text-primary', bg: 'bg-primary/10', label: 'Processing', animate: true },
  completed: { icon: 'check_circle', color: 'text-success', bg: 'bg-success/10', label: 'Completed', animate: false },
  failed: { icon: 'error', color: 'text-destructive', bg: 'bg-destructive/10', label: 'Failed', animate: false },
} as const;

const LOG_LEVEL_CONFIG = {
  info: { icon: 'info', color: 'text-info' },
  warn: { icon: 'warning', color: 'text-warning' },
  error: { icon: 'cancel', color: 'text-destructive' },
  debug: { icon: 'description', color: 'text-on-surface-variant' },
} as const;

export function ProcessingStatusCard({ job, logs, fileName, onRetry, className }: ProcessingStatusCardProps) {
  const { toast } = useToast();
  const [isLogsOpen, setIsLogsOpen] = useState(false);
  const [elapsedTime, setElapsedTime] = useState<string>('');
  const [isRetrying, setIsRetrying] = useState(false);

  useEffect(() => {
    if (!job?.started_at) {
      setElapsedTime('');
      return;
    }

    const startTime = new Date(job.started_at).getTime();
    const endTime = job.completed_at ? new Date(job.completed_at).getTime() : null;

    const updateElapsed = () => {
      const now = endTime || Date.now();
      const elapsed = Math.floor((now - startTime) / 1000);
      const minutes = Math.floor(elapsed / 60);
      const seconds = elapsed % 60;
      setElapsedTime(minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`);
    };

    updateElapsed();

    if (!endTime) {
      const interval = setInterval(updateElapsed, 1000);
      return () => clearInterval(interval);
    }
  }, [job?.started_at, job?.completed_at]);

  const handleRetry = async () => {
    if (!job || isRetrying) return;

    setIsRetrying(true);
    try {
      const { error } = await supabase
        .from('claim_documents')
        .update({ processing_status: 'pending', processing_error: null })
        .eq('id', job.document_id);

      if (error) throw error;

      toast({ title: 'Retry Initiated', description: 'Document has been queued for reprocessing.' });
      onRetry?.();
    } catch (error) {
      console.error('Retry error:', error);
      toast({
        title: 'Retry Failed',
        description: error instanceof Error ? error.message : 'Failed to retry processing',
        variant: 'destructive',
      });
    } finally {
      setIsRetrying(false);
    }
  };

  if (!job) return null;

  const statusConfig = STATUS_CONFIG[job.status];
  const canRetry = job.status === 'failed' && isRetryableError(job.error_code);
  const showManualRetry = job.status === 'failed' && !isRetryableError(job.error_code);

  return (
    <Card className={cn('border-2 transition-colors duration-300 rounded-2xl', statusConfig.bg, className)}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-headline-sm font-semibold flex items-center gap-2 text-primary">
            <Icon
              name={statusConfig.icon}
              size={20}
              filled={statusConfig.icon === 'check_circle' || statusConfig.icon === 'error'}
              className={cn(statusConfig.color, statusConfig.animate && 'animate-spin')}
            />
            <span>{statusConfig.label}</span>
            {fileName && (
              <Badge variant="outline" className="ml-2 font-normal rounded-full">
                {fileName}
              </Badge>
            )}
          </CardTitle>
          <div className="flex items-center gap-2">
            {elapsedTime && <span className="text-xs text-on-surface-variant">{elapsedTime}</span>}
            {(canRetry || showManualRetry) && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleRetry}
                disabled={isRetrying}
                className="gap-1.5"
              >
                {isRetrying ? (
                  <Icon name="progress_activity" size={14} className="animate-spin" />
                ) : (
                  <Icon name="refresh" size={14} />
                )}
                Retry
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-on-surface-variant">{job.current_step || 'Initializing...'}</span>
            <span className="font-mono text-xs">{job.progress}%</span>
          </div>
          <Progress
            value={job.progress}
            className={cn('h-2', job.status === 'failed' && '[&>div]:bg-destructive')}
          />
        </div>

        {job.error_message && (
          <div className="bg-destructive/10 border border-destructive/20 rounded-xl p-3">
            <div className="flex items-start gap-2">
              <Icon name="error" size={16} filled className="text-destructive mt-0.5 flex-shrink-0" />
              <div className="text-sm">
                <p className="font-semibold text-destructive">Error</p>
                <p className="text-on-surface-variant mt-1">{job.error_message}</p>
                {job.error_code && (
                  <p className="text-xs text-on-surface-variant mt-1">Code: {job.error_code}</p>
                )}
                {job.retry_count > 0 && (
                  <p className="text-xs text-on-surface-variant mt-1">
                    Retry attempts: {job.retry_count}/{job.max_retries}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {logs.length > 0 && (
          <Collapsible open={isLogsOpen} onOpenChange={setIsLogsOpen}>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="w-full justify-between">
                <span className="text-xs text-on-surface-variant">Processing Logs ({logs.length})</span>
                <Icon name={isLogsOpen ? 'expand_less' : 'expand_more'} size={16} />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ScrollArea className="h-40 mt-2 rounded-md border border-outline-variant bg-surface-container-low/40 p-2">
                <div className="space-y-1">
                  {logs.map((log) => {
                    const levelConfig = LOG_LEVEL_CONFIG[log.level];
                    return (
                      <div
                        key={log.id}
                        className={cn(
                          'flex items-start gap-2 text-xs py-1 px-2 rounded',
                          log.level === 'error' && 'bg-destructive/10',
                        )}
                      >
                        <Icon
                          name={levelConfig.icon}
                          size={12}
                          className={cn('mt-0.5 flex-shrink-0', levelConfig.color)}
                        />
                        <span className="text-on-surface-variant font-mono flex-shrink-0">
                          {new Date(log.created_at).toLocaleTimeString()}
                        </span>
                        <span className="flex-1">{log.message}</span>
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            </CollapsibleContent>
          </Collapsible>
        )}
      </CardContent>
    </Card>
  );
}
