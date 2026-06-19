import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/Icon";

// Lightweight pre-login access gate. This is deliberate OBFUSCATION to keep the
// demo from being casually/accidentally discovered — it is NOT real security
// (these values ship in the client bundle and are visible in devtools). The
// real authentication is the Supabase login that sits behind this overlay.
const GATE_USER_ID = "porche";
const GATE_PASSWORD = "chevynova";
const GATE_STORAGE_KEY = "spej_gate_ok";

export function isGateUnlocked(): boolean {
  try {
    return sessionStorage.getItem(GATE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

interface AccessGateProps {
  onUnlock: () => void;
}

export function AccessGate({ onUnlock }: AccessGateProps) {
  const [userId, setUserId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (userId.trim() === GATE_USER_ID && password === GATE_PASSWORD) {
      try {
        sessionStorage.setItem(GATE_STORAGE_KEY, "1");
      } catch {
        /* sessionStorage unavailable — unlock for this render only */
      }
      setError(false);
      onUnlock();
    } else {
      setError(true);
    }
  };

  return (
    // Full-screen blur+dim overlay: obscures the login card behind it until unlocked.
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-xl">
      <Card className="w-full max-w-sm p-6 bg-surface-container-lowest border-outline-variant shadow-elevation-2 rounded-2xl">
        <div className="flex flex-col items-center text-center mb-6">
          <div className="w-12 h-12 rounded-xl bg-primary-container text-on-primary-container flex items-center justify-center mb-3">
            <Icon name="lock" size={24} filled />
          </div>
          <h1 className="text-headline-sm text-primary">Authorized access only</h1>
          <p className="text-body-sm text-on-surface-variant mt-1">
            Enter your access credentials to continue.
          </p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4" autoComplete="off">
          <div className="space-y-2">
            <Label htmlFor="gate-user" className="text-on-surface">
              User ID
            </Label>
            <Input
              id="gate-user"
              type="text"
              autoComplete="off"
              autoFocus
              value={userId}
              onChange={(e) => {
                setUserId(e.target.value);
                setError(false);
              }}
              className={error ? "border-destructive" : ""}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="gate-pass" className="text-on-surface">
              Password
            </Label>
            <Input
              id="gate-pass"
              type="password"
              autoComplete="off"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(false);
              }}
              className={error ? "border-destructive" : ""}
            />
          </div>
          {error && <p className="text-xs text-destructive">Incorrect credentials.</p>}
          <Button type="submit" className="w-full">
            Continue
          </Button>
        </form>
      </Card>
    </div>
  );
}
