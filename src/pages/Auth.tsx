import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Icon } from "@/components/Icon";
import { z } from "zod";
import { cn } from "@/lib/utils";
import { ForgotPasswordDialog } from "@/components/ForgotPasswordDialog";

const authSchema = z.object({
  email: z.string().email("Please enter a valid email address"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  fullName: z.string().min(2, "Name must be at least 2 characters").optional(),
});

export default function Auth() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [isLogin, setIsLogin] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [formData, setFormData] = useState({ email: "", password: "", fullName: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  // After a successful signup, replace the form with a "check your email"
  // confirmation panel. We can't just toast + flip-to-login because email
  // confirmation is required (mailer_autoconfirm=false) AND admin approval
  // is required after that — the user can't sign in yet either way.
  const [pendingConfirmationEmail, setPendingConfirmationEmail] = useState<string | null>(null);

  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") {
        navigate("/reset-password");
      }
    });
    return () => subscription.unsubscribe();
  }, [navigate]);

  const validateForm = () => {
    try {
      if (isLogin) {
        authSchema.pick({ email: true, password: true }).parse(formData);
      } else {
        authSchema.parse({ ...formData, fullName: formData.fullName || undefined });
      }
      setErrors({});
      return true;
    } catch (error) {
      if (error instanceof z.ZodError) {
        const newErrors: Record<string, string> = {};
        error.errors.forEach((err) => {
          if (err.path[0]) {
            newErrors[err.path[0] as string] = err.message;
          }
        });
        setErrors(newErrors);
      }
      return false;
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateForm()) return;
    setIsLoading(true);
    try {
      if (isLogin) {
        const { error } = await supabase.auth.signInWithPassword({
          email: formData.email,
          password: formData.password,
        });
        if (error) throw error;
        // ProtectedRoute / useMFAStatus handle the AAL2 gate — if this user has
        // a verified TOTP factor they'll be prompted to verify before the app
        // renders, and if they have none they'll be force-enrolled.
        toast({ title: "Welcome back!", description: "You've successfully signed in." });
        navigate("/");
      } else {
        const { error } = await supabase.auth.signUp({
          email: formData.email,
          password: formData.password,
          options: { emailRedirectTo: `${window.location.origin}/`, data: { full_name: formData.fullName } },
        });
        if (error) throw error;
        // Email confirmation is required (mailer_autoconfirm=false) AND an
        // admin must approve the account before any roles are granted, so
        // do NOT flip to the login form — show a clear confirmation panel
        // explaining both steps so the user knows what to expect next.
        setPendingConfirmationEmail(formData.email);
      }
    } catch (error: any) {
      let message = "An error occurred. Please try again.";
      if (error.message?.includes("Invalid login credentials")) message = "Invalid email or password.";
      else if (error.message?.includes("User already registered")) message = "This email is already registered.";
      else if (error.message) message = error.message;
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  };

  if (showForgotPassword) return <ForgotPasswordDialog onBack={() => setShowForgotPassword(false)} />;

  if (pendingConfirmationEmail) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <img src="/logo.png" alt="Nodak Insurance" className="h-16 w-auto mx-auto mb-4" />
            <h1 className="text-headline-md text-primary">Nodak Demand Packet Review Portal</h1>
            <p className="text-body-md text-on-surface-variant mt-1">Check your email to continue</p>
          </div>
          <Card className="p-6 bg-surface-container-lowest border-outline-variant shadow-elevation-1 rounded-2xl space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-lg bg-primary-container text-on-primary-container flex items-center justify-center shrink-0">
                <Icon name="mark_email_read" size={20} filled />
              </div>
              <div>
                <h2 className="text-headline-sm text-primary">Confirm your email</h2>
                <p className="text-body-md text-on-surface-variant mt-1">
                  We sent a confirmation link to{" "}
                  <strong className="text-on-surface">{pendingConfirmationEmail}</strong>. Click the link
                  to verify your email address.
                </p>
              </div>
            </div>
            <div className="rounded-xl border border-warning/30 bg-warning/10 p-4 text-sm text-on-surface">
              <div className="flex items-start gap-2">
                <Icon name="info" size={16} filled className="text-warning mt-0.5 shrink-0" />
                <p>
                  <strong>One more step after that:</strong> a Nodak administrator must approve your
                  account and assign a role before you can use the portal. You'll be held at a
                  pending-approval screen on first sign-in until that happens.
                </p>
              </div>
            </div>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => {
                setPendingConfirmationEmail(null);
                setIsLogin(true);
                setFormData({ email: "", password: "", fullName: "" });
                setErrors({});
              }}
            >
              Back to Sign In
            </Button>
          </Card>
          <p className="text-xs text-on-surface-variant text-center mt-6">
            Didn't receive an email? Check your spam folder, or contact IT support.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <img src="/logo.png" alt="Nodak Insurance" className="h-16 w-auto mx-auto mb-4" />
          <h1 className="text-headline-md text-primary">Nodak Demand Packet Review Portal</h1>
          <p className="text-body-md text-on-surface-variant mt-1">Internal Document Review System</p>
        </div>
        <Card className="p-6 bg-surface-container-lowest border-outline-variant shadow-elevation-1 rounded-2xl">
          <form onSubmit={handleSubmit} className="space-y-4">
            {!isLogin && (
              <div className="space-y-2">
                <Label htmlFor="fullName" className="flex items-center gap-2 text-on-surface">
                  <Icon name="person" size={16} /> Full Name
                </Label>
                <Input
                  id="fullName"
                  type="text"
                  placeholder="John Smith"
                  value={formData.fullName}
                  onChange={(e) => setFormData({ ...formData, fullName: e.target.value })}
                  className={errors.fullName ? "border-destructive" : ""}
                />
                {errors.fullName && <p className="text-xs text-destructive">{errors.fullName}</p>}
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="email" className="flex items-center gap-2 text-on-surface">
                <Icon name="mail" size={16} /> Work Email
              </Label>
              <Input
                id="email"
                type="email"
                placeholder="john.smith@nodakins.com"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                className={errors.email ? "border-destructive" : ""}
              />
              {errors.email && <p className="text-xs text-destructive">{errors.email}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="password" className="flex items-center gap-2 text-on-surface">
                <Icon name="lock" size={16} /> Password
              </Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  placeholder="••••••••"
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  className={cn("pr-10", errors.password && "border-destructive")}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="absolute inset-y-0 right-0 px-3 flex items-center text-on-surface-variant hover:text-primary transition-colors"
                >
                  <Icon name={showPassword ? "visibility_off" : "visibility"} size={18} />
                </button>
              </div>
              {errors.password && <p className="text-xs text-destructive">{errors.password}</p>}
            </div>
            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading ? (
                <>
                  <Icon name="progress_activity" size={16} className="mr-2 animate-spin" />
                  {isLogin ? "Signing in..." : "Creating account..."}
                </>
              ) : isLogin ? (
                "Sign In"
              ) : (
                "Create Account"
              )}
            </Button>
          </form>
          <div className="mt-6 space-y-3 text-center">
            {isLogin && (
              <div>
                <button
                  type="button"
                  onClick={() => setShowForgotPassword(true)}
                  className="text-sm text-on-surface-variant hover:text-primary transition-colors"
                >
                  Forgot password?
                </button>
              </div>
            )}
            <button
              type="button"
              onClick={() => {
                setIsLogin(!isLogin);
                setErrors({});
              }}
              className="block w-full text-sm text-on-surface-variant hover:text-primary transition-colors"
            >
              {isLogin ? "Need an account? Register" : "Already have an account? Sign in"}
            </button>
          </div>
        </Card>
        <p className="text-xs text-on-surface-variant text-center mt-6">
          For authorized Nodak Insurance personnel only.
          <br />
          Contact IT support if you need access.
        </p>
      </div>
    </div>
  );
}
