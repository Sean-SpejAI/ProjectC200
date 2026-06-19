import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Icon } from "@/components/Icon";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";

interface MFAEnrollProps {
  onComplete: () => void;
  onCancel?: () => void;
  /**
   * If provided, the "2FA is enabled" view gets a primary Continue button
   * that fires onContinue. Used by MFAEnrollGate so users who land on the
   * isEnrolled view (e.g. after a loading flicker reset their place in the
   * gate) still have a way to advance into the app.
   */
  continueLabel?: string;
  onContinue?: () => void;
}

export function MFAEnroll({ onComplete, onCancel, continueLabel, onContinue }: MFAEnrollProps) {
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(true);
  const [isVerifying, setIsVerifying] = useState(false);
  const [qrCode, setQrCode] = useState("");
  const [secret, setSecret] = useState("");
  const [factorId, setFactorId] = useState("");
  const [verifyCode, setVerifyCode] = useState("");
  const [isEnrolled, setIsEnrolled] = useState(false);

  useEffect(() => {
    checkExistingEnrollment();
  }, []);

  const checkExistingEnrollment = async () => {
    try {
      const { data, error } = await supabase.auth.mfa.listFactors();
      if (error) throw error;
      if (data.totp.find((f) => f.status === "verified")) setIsEnrolled(true);
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoading(false);
    }
  };

  const startEnrollment = async () => {
    setIsLoading(true);
    try {
      // Clear any half-finished (unverified) enrollments first; Supabase rejects
      // a second enroll() while an unverified factor exists.
      const { data: existing } = await supabase.auth.mfa.listFactors();
      const unverified = existing?.totp.filter((f) => f.status === "unverified") ?? [];
      for (const f of unverified) {
        await supabase.auth.mfa.unenroll({ factorId: f.id });
      }

      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: "Authenticator App",
        issuer: "Spej Demand Packet App",
      });
      if (error) throw error;
      setQrCode(data.totp.qr_code);
      setSecret(data.totp.secret);
      setFactorId(data.id);
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  };

  const verifyAndActivate = async () => {
    if (verifyCode.length !== 6) return;
    setIsVerifying(true);
    try {
      const { data: cd, error: ce } = await supabase.auth.mfa.challenge({ factorId });
      if (ce) throw ce;
      const { error: ve } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: cd.id,
        code: verifyCode,
      });
      if (ve) throw ve;
      toast({ title: "2FA Enabled" });
      onComplete();
    } catch (e: any) {
      toast({ title: "Failed", description: e.message, variant: "destructive" });
      setVerifyCode("");
    } finally {
      setIsVerifying(false);
    }
  };

  const cardClass = "p-6 bg-surface-container-lowest border-outline-variant shadow-elevation-1 rounded-2xl";

  if (isLoading)
    return (
      <div className="flex items-center justify-center p-8">
        <Icon name="progress_activity" size={24} className="animate-spin text-on-surface-variant" />
      </div>
    );

  if (isEnrolled) {
    return (
      <Card className={cardClass}>
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-lg bg-success/10 text-success flex items-center justify-center">
            <Icon name="verified_user" size={20} filled />
          </div>
          <div>
            <h3 className="text-headline-sm text-primary">2FA is enabled</h3>
            <p className="text-body-md text-on-surface-variant">
              Your account is protected by an authenticator app. Contact your admin if you need to
              reset your authenticator or backup codes.
            </p>
          </div>
        </div>
        {continueLabel && onContinue && (
          <Button onClick={onContinue} className="w-full">
            {continueLabel}
          </Button>
        )}
      </Card>
    );
  }

  if (!qrCode)
    return (
      <Card className={cardClass}>
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-lg bg-primary-container text-on-primary-container flex items-center justify-center">
            <Icon name="security" size={20} filled />
          </div>
          <div>
            <h3 className="text-headline-sm text-primary">Enable two-factor authentication</h3>
            <p className="text-body-md text-on-surface-variant">Add an extra layer of security</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button onClick={startEnrollment} className="flex-1">
            <Icon name="smartphone" size={16} className="mr-2" />
            Set up 2FA
          </Button>
          {onCancel && (
            <Button variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      </Card>
    );

  return (
    <Card className={cardClass}>
      <div className="space-y-6">
        <div className="text-center">
          <h3 className="text-headline-sm text-primary mb-2">Scan QR code</h3>
          <p className="text-body-md text-on-surface-variant">
            Use Google Authenticator to scan this code.
          </p>
        </div>
        <div className="flex justify-center">
          <div className="p-4 bg-white rounded-xl shadow-elevation-1">
            <img src={qrCode} alt="QR Code for 2FA" className="w-48 h-48" />
          </div>
        </div>
        <div className="text-center">
          <p className="text-xs text-on-surface-variant mb-1">Or enter manually:</p>
          <code className="text-sm bg-surface-container-low px-3 py-1.5 rounded font-mono select-all">
            {secret}
          </code>
        </div>
        <div className="space-y-3">
          <p className="text-body-md font-medium text-center">Enter the 6-digit code</p>
          <div className="flex justify-center">
            <InputOTP maxLength={6} value={verifyCode} onChange={setVerifyCode}>
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
        </div>
        <div className="flex gap-2">
          <Button
            onClick={verifyAndActivate}
            disabled={verifyCode.length !== 6 || isVerifying}
            className="flex-1"
          >
            {isVerifying ? (
              <>
                <Icon name="progress_activity" size={16} className="mr-2 animate-spin" />
                Verifying...
              </>
            ) : (
              "Verify & enable 2FA"
            )}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setQrCode("");
              setSecret("");
              setFactorId("");
            }}
          >
            Restart
          </Button>
        </div>
      </div>
    </Card>
  );
}
