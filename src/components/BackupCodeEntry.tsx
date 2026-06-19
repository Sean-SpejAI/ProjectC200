import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { Icon } from "@/components/Icon";

interface BackupCodeEntryProps {
  onBack: () => void;
}

/**
 * Form for redeeming a backup code when the authenticator app is unavailable.
 * On success the user's TOTP factor is wiped, they're signed out, and they
 * re-enroll on a new device.
 */
export function BackupCodeEntry({ onBack }: BackupCodeEntryProps) {
  const { toast } = useToast();
  const [code, setCode] = useState("");
  const [isVerifying, setIsVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    setIsVerifying(true);
    setError(null);
    try {
      const { data, error: invokeErr } = await supabase.functions.invoke(
        "verify-backup-code",
        { body: { code: code.trim() } },
      );
      if (invokeErr) {
        throw invokeErr;
      }
      if (!data?.success) {
        throw new Error("Invalid or already-used backup code.");
      }

      toast({
        title: "Backup code accepted",
        description: "Sign in again to enroll a new authenticator app.",
      });
      await supabase.auth.signOut();
      // ProtectedRoute will pick up the sign-out and bounce to /auth.
    } catch (err: any) {
      const msg = err?.message?.includes("invalid_code")
        ? "That backup code is invalid or has already been used."
        : err?.message || "Couldn't verify backup code.";
      setError(msg);
    } finally {
      setIsVerifying(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <p className="text-body-md text-on-surface-variant">
          Enter one of the backup codes you saved when you set up 2FA. The code is 10 characters,
          formatted as <span className="font-mono">XXXX-XXXX-XX</span>.
        </p>
      </div>
      <Input
        autoFocus
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="XXXX-XXXX-XX"
        className="font-mono tracking-wider text-center"
        disabled={isVerifying}
      />
      {error && <p className="text-xs text-destructive text-center">{error}</p>}
      <Button type="submit" className="w-full" disabled={!code.trim() || isVerifying}>
        {isVerifying ? (
          <>
            <Icon name="progress_activity" size={16} className="mr-2 animate-spin" />
            Verifying...
          </>
        ) : (
          "Use backup code"
        )}
      </Button>
      <button
        type="button"
        onClick={onBack}
        className="block w-full text-sm text-on-surface-variant hover:text-primary transition-colors"
      >
        ← Back to authenticator code
      </button>
    </form>
  );
}
