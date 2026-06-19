import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/Icon";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

interface BackupCodesDisplayProps {
  onAcknowledge: () => void;
  acknowledgeLabel?: string;
}

export function BackupCodesDisplay({
  onAcknowledge,
  acknowledgeLabel = "Continue",
}: BackupCodesDisplayProps) {
  const { toast } = useToast();
  const [codes, setCodes] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data, error: invokeErr } = await supabase.functions.invoke(
          "generate-backup-codes",
        );
        if (cancelled) return;
        if (invokeErr) throw invokeErr;
        if (!data?.codes || !Array.isArray(data.codes)) {
          throw new Error("No codes returned");
        }
        setCodes(data.codes);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || "Failed to generate backup codes");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const copyAll = async () => {
    if (!codes) return;
    await navigator.clipboard.writeText(codes.join("\n"));
    toast({ title: "Copied", description: "Backup codes copied to your clipboard." });
  };

  const downloadTxt = () => {
    if (!codes) return;
    const header = "Spej Demand Packet Review Portal — backup codes\nGenerated " + new Date().toISOString() + "\n\n";
    const body = codes.join("\n") + "\n";
    const blob = new Blob([header + body], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "spej-backup-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <Card className="p-8 bg-surface-container-lowest border-outline-variant shadow-elevation-1 rounded-2xl flex items-center justify-center gap-3 text-on-surface-variant">
        <Icon name="progress_activity" size={20} className="animate-spin" />
        Generating backup codes...
      </Card>
    );
  }

  if (error || !codes) {
    return (
      <Card className="p-6 bg-destructive/5 border-destructive/30 shadow-elevation-1 rounded-2xl">
        <div className="flex items-start gap-3">
          <Icon name="error" size={20} filled className="text-destructive shrink-0 mt-0.5" />
          <div>
            <p className="text-body-md font-semibold text-destructive">Couldn't generate backup codes</p>
            <p className="text-body-md text-on-surface-variant mt-1">
              {error || "Please try again. Contact IT support if this keeps happening."}
            </p>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-6 bg-surface-container-lowest border-outline-variant shadow-elevation-1 rounded-2xl space-y-5">
      <div className="bg-warning/10 border border-warning/30 rounded-xl p-4 flex items-start gap-3">
        <Icon name="warning" size={20} filled className="text-warning shrink-0 mt-0.5" />
        <div className="text-body-md text-on-surface">
          <p className="font-semibold">Save these now.</p>
          <p className="text-on-surface-variant mt-1">
            These codes will not be shown again. Each one works exactly once and replaces your
            authenticator app if you lose access.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {codes.map((c, i) => (
          <div
            key={i}
            className="font-mono text-body-md bg-surface-container-low border border-outline-variant rounded-lg px-4 py-3 text-on-surface tracking-wider"
          >
            {c}
          </div>
        ))}
      </div>

      <div className="flex gap-2">
        <Button variant="outline" onClick={copyAll} className="gap-2 flex-1">
          <Icon name="content_copy" size={16} />
          Copy all
        </Button>
        <Button variant="outline" onClick={downloadTxt} className="gap-2 flex-1">
          <Icon name="download" size={16} />
          Download .txt
        </Button>
      </div>

      <label className="flex items-start gap-3 cursor-pointer">
        <Checkbox
          checked={acknowledged}
          onCheckedChange={(v) => setAcknowledged(v === true)}
          className="mt-0.5"
        />
        <span className="text-body-md text-on-surface">
          I have saved these codes in a secure location.
        </span>
      </label>

      <Button onClick={onAcknowledge} disabled={!acknowledged} className="w-full">
        {acknowledgeLabel}
      </Button>
    </Card>
  );
}
