import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Icon } from "@/components/Icon";
import { z } from "zod";

const resetPasswordSchema = z
  .object({
    password: z.string().min(6, "Password must be at least 6 characters"),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ["confirmPassword"],
  });

export default function ResetPassword() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [formData, setFormData] = useState({ password: "", confirmPassword: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const validateForm = () => {
    try {
      resetPasswordSchema.parse(formData);
      setErrors({});
      return true;
    } catch (error) {
      if (error instanceof z.ZodError) {
        const e: Record<string, string> = {};
        error.errors.forEach((err) => {
          if (err.path[0]) e[err.path[0] as string] = err.message;
        });
        setErrors(e);
      }
      return false;
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateForm()) return;
    setIsLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: formData.password });
      if (error) throw error;
      setIsResetting(true);
      toast({ title: "Password updated!", description: "Redirecting to sign in..." });
      setTimeout(() => navigate("/auth"), 2000);
    } catch (error: any) {
      toast({ title: "Error", description: error.message || "An error occurred.", variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  };

  if (isResetting) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="p-8 text-center space-y-4 w-full max-w-md bg-surface-container-lowest border-outline-variant shadow-elevation-1 rounded-2xl">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary text-primary-foreground">
            <Icon name="check_circle" size={32} filled />
          </div>
          <h2 className="text-headline-sm font-bold text-primary">Password Reset Successful</h2>
          <p className="text-on-surface-variant">Redirecting you to sign in...</p>
          <Icon name="progress_activity" size={20} className="animate-spin mx-auto text-primary" />
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <img src="/logo.png" alt="Spej" className="h-16 w-auto mx-auto mb-4" />
          <h1 className="text-headline-md text-primary">Spej Demand Packet Review Portal</h1>
          <p className="text-body-md text-on-surface-variant mt-1">Create a new password</p>
        </div>
        <Card className="p-6 bg-surface-container-lowest border-outline-variant shadow-elevation-1 rounded-2xl">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="password" className="flex items-center gap-2 text-on-surface">
                <Icon name="lock" size={16} /> New Password
              </Label>
              <Input
                id="password"
                type="password"
                placeholder="••••••••"
                value={formData.password}
                onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                className={errors.password ? "border-destructive" : ""}
                disabled={isLoading}
              />
              {errors.password && <p className="text-xs text-destructive">{errors.password}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirmPassword" className="flex items-center gap-2 text-on-surface">
                <Icon name="lock" size={16} /> Confirm Password
              </Label>
              <Input
                id="confirmPassword"
                type="password"
                placeholder="••••••••"
                value={formData.confirmPassword}
                onChange={(e) => setFormData({ ...formData, confirmPassword: e.target.value })}
                className={errors.confirmPassword ? "border-destructive" : ""}
                disabled={isLoading}
              />
              {errors.confirmPassword && <p className="text-xs text-destructive">{errors.confirmPassword}</p>}
            </div>
            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading ? (
                <>
                  <Icon name="progress_activity" size={16} className="mr-2 animate-spin" />
                  Resetting Password...
                </>
              ) : (
                "Reset Password"
              )}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
