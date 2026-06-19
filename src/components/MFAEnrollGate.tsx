import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Icon } from "@/components/Icon";
import { MFAEnroll } from "@/components/MFAEnroll";
import { BackupCodesDisplay } from "@/components/BackupCodesDisplay";

interface MFAEnrollGateProps {
  onComplete: () => void;
}

/**
 * Full-screen forced enrollment shown when a signed-in user has no verified
 * TOTP factor. Renders MFAEnroll, then transitions to BackupCodesDisplay
 * (mandatory acknowledgement) before releasing the app to the user.
 */
export function MFAEnrollGate({ onComplete }: MFAEnrollGateProps) {
  const { toast } = useToast();
  const [stage, setStage] = useState<"enroll" | "codes">("enroll");

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    toast({ title: "Signed out" });
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="flex justify-between items-center px-6 py-4 border-b border-outline-variant bg-surface">
        <div className="flex items-center gap-3">
          <img src="/logo.png" alt="Nodak Insurance" className="h-9 w-auto" />
          <div>
            <p className="text-label-md text-on-surface-variant uppercase tracking-widest">
              Account security
            </p>
            <p className="text-headline-sm text-primary">Set up two-factor authentication</p>
          </div>
        </div>
        <button
          onClick={handleSignOut}
          className="flex items-center gap-2 text-label-md text-on-surface-variant hover:text-primary transition-colors"
        >
          <Icon name="logout" size={18} />
          Sign out
        </button>
      </header>

      <main className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-xl space-y-6">
          {stage === "enroll" && (
            <>
              <div className="text-center">
                <h1 className="text-headline-md text-primary">Two-factor authentication is required</h1>
                <p className="text-body-md text-on-surface-variant mt-2">
                  To protect claim documents and PII, every account must use Google Authenticator.
                  This is a one-time setup.
                </p>
              </div>
              <MFAEnroll
                onComplete={() => setStage("codes")}
                continueLabel="Continue to app"
                onContinue={onComplete}
              />
            </>
          )}

          {stage === "codes" && (
            <>
              <div className="text-center">
                <h1 className="text-headline-md text-primary">Save your backup codes</h1>
                <p className="text-body-md text-on-surface-variant mt-2">
                  Use one of these if you lose access to your authenticator app. Each code works
                  exactly once and they won't be shown again.
                </p>
              </div>
              <BackupCodesDisplay onAcknowledge={onComplete} />
            </>
          )}
        </div>
      </main>
    </div>
  );
}
