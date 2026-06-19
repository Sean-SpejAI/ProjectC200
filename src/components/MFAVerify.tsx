import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Icon } from "@/components/Icon";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { BackupCodeEntry } from "@/components/BackupCodeEntry";

interface MFAVerifyProps {
  onSuccess: () => void;
  onCancel: () => void;
}

export function MFAVerify({ onSuccess, onCancel }: MFAVerifyProps) {
  const { toast } = useToast();
  const [isVerifying, setIsVerifying] = useState(false);
  const [code, setCode] = useState("");
  const [mode, setMode] = useState<"totp" | "backup">("totp");

  const handleVerify = async () => {
    if (code.length !== 6) return;
    setIsVerifying(true);
    try {
      const { data: factors, error: factorsError } = await supabase.auth.mfa.listFactors();
      if (factorsError) throw factorsError;
      const totpFactor = factors.totp.find((f) => f.status === "verified");
      if (!totpFactor) throw new Error("No verified TOTP factor found");
      const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({
        factorId: totpFactor.id,
      });
      if (challengeError) throw challengeError;
      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId: totpFactor.id,
        challengeId: challengeData.id,
        code,
      });
      if (verifyError) throw verifyError;
      onSuccess();
    } catch (error: any) {
      toast({
        title: "Verification Failed",
        description: error.message || "Invalid code.",
        variant: "destructive",
      });
      setCode("");
    } finally {
      setIsVerifying(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary text-primary-foreground mb-4 shadow-elevation-1">
            <Icon name="security" size={32} filled />
          </div>
          <h1 className="text-headline-md text-primary">Two-Factor Authentication</h1>
          <p className="text-body-md text-on-surface-variant mt-1">
            {mode === "totp"
              ? "Enter the code from your authenticator app"
              : "Use one of your saved backup codes"}
          </p>
        </div>
        <Card className="p-6 bg-surface-container-lowest border-outline-variant shadow-elevation-1 rounded-2xl">
          {mode === "totp" ? (
            <div className="space-y-6">
              <div className="flex justify-center">
                <InputOTP maxLength={6} value={code} onChange={setCode} autoFocus>
                  <InputOTPGroup>
                    <InputOTPSlot index={0} />
                    <InputOTPSlot index={1} />
                    <InputOTPSlot index={2} />
                    <InputOTPSlot index={3} />
                    <InputOTPSlot index={4} />
                    <InputOTPSlot index={5} />
                  </InputOTPGroup>
                </InputOTP>
              </div>
              <Button onClick={handleVerify} disabled={code.length !== 6 || isVerifying} className="w-full">
                {isVerifying ? (
                  <>
                    <Icon name="progress_activity" size={16} className="mr-2 animate-spin" />
                    Verifying...
                  </>
                ) : (
                  "Verify"
                )}
              </Button>
              <button
                type="button"
                onClick={() => setMode("backup")}
                className="w-full text-sm text-on-surface-variant hover:text-primary transition-colors"
              >
                Lost your device? Use a backup code
              </button>
              <button
                type="button"
                onClick={onCancel}
                className="w-full text-sm text-on-surface-variant hover:text-primary transition-colors"
              >
                Use a different account
              </button>
            </div>
          ) : (
            <BackupCodeEntry onBack={() => setMode("totp")} />
          )}
        </Card>
      </div>
    </div>
  );
}
