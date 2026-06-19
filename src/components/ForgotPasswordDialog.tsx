import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Icon } from "@/components/Icon";
import { z } from "zod";

const emailSchema = z.object({ email: z.string().email("Please enter a valid email address") });

interface ForgotPasswordDialogProps {
  onBack: () => void;
}

export function ForgotPasswordDialog({ onBack }: ForgotPasswordDialogProps) {
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      emailSchema.parse({ email });
      setIsLoading(true);
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth?tab=reset`,
      });
      if (resetError) throw resetError;
      setIsSubmitted(true);
      toast({
        title: "Reset email sent!",
        description: "Check your email for password reset instructions.",
      });
    } catch (err: any) {
      const message = err instanceof z.ZodError ? err.errors[0].message : err.message || "An error occurred.";
      setError(message);
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <img src="/logo.png" alt="Nodak Insurance" className="h-16 w-auto mx-auto mb-4" />
          <h1 className="text-headline-md text-primary">Nodak Demand Packet Review Portal</h1>
          <p className="text-body-md text-on-surface-variant mt-1">Reset your password</p>
        </div>
        <Card className="p-6 bg-surface-container-lowest border-outline-variant shadow-elevation-1 rounded-2xl">
          {isSubmitted ? (
            <div className="space-y-4 text-center">
              <div className="bg-success/10 border border-success/20 rounded-xl p-4">
                <p className="text-body-md font-semibold text-on-surface mb-2">✓ Password reset email sent!</p>
                <p className="text-body-md text-on-surface-variant">
                  Check <strong>{email}</strong> for instructions.
                </p>
              </div>
              <Button onClick={onBack} className="w-full">
                Back to Sign In
              </Button>
            </div>
          ) : (
            <>
              <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email" className="flex items-center gap-2 text-on-surface">
                  <Icon name="mail" size={16} /> Work Email
                </Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="john.smith@nodakins.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={error ? "border-destructive" : ""}
                  disabled={isLoading}
                />
                {error && <p className="text-xs text-destructive">{error}</p>}
              </div>
              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? (
                  <>
                    <Icon name="progress_activity" size={16} className="mr-2 animate-spin" />
                    Sending...
                  </>
                ) : (
                  "Send Reset Email"
                )}
              </Button>
              </form>
              <div className="mt-6 text-center">
                <button
                  type="button"
                  onClick={onBack}
                  className="text-sm text-on-surface-variant hover:text-primary transition-colors inline-flex items-center gap-1"
                >
                  <Icon name="arrow_back" size={14} />
                  Back to Sign In
                </button>
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
