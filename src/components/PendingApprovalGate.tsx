import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Icon } from "@/components/Icon";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

/**
 * Shown to authenticated users who have completed 2FA but have not yet been
 * granted any role by an admin. They can't access the app until approved.
 */
export function PendingApprovalGate() {
  const { user } = useAuth();

  const handleSignOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="flex justify-between items-center px-6 py-4 border-b border-outline-variant bg-surface">
        <div className="flex items-center gap-3">
          <img src="/logo.png" alt="Spej" className="h-9 w-auto" />
          <div>
            <p className="text-label-md text-on-surface-variant uppercase tracking-widest">Account status</p>
            <p className="text-headline-sm text-primary">Pending approval</p>
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
        <Card className="w-full max-w-lg p-8 text-center space-y-5 bg-surface-container-lowest border-outline-variant shadow-elevation-1 rounded-2xl">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-warning/10 text-warning">
            <Icon name="hourglass_empty" size={32} filled />
          </div>
          <div className="space-y-2">
            <h1 className="text-headline-md text-primary">Waiting for admin approval</h1>
            <p className="text-body-md text-on-surface-variant">
              Your account ({user?.email}) is registered, but an administrator must grant you access before
              you can use the Project C200 Demo Portal. You'll be notified once that happens.
            </p>
          </div>
          <div className="bg-surface-container-low border border-outline-variant rounded-xl p-4 text-left">
            <p className="text-label-md text-on-surface-variant uppercase tracking-widest mb-2">
              Next steps
            </p>
            <ul className="text-body-md text-on-surface-variant space-y-1 list-disc list-inside">
              <li>Contact IT support or your Spej admin to request access.</li>
              <li>Once your access is approved, sign back in to enter the portal.</li>
            </ul>
          </div>
          <Button variant="outline" onClick={handleSignOut} className="w-full">
            <Icon name="logout" size={16} className="mr-2" />
            Sign out
          </Button>
        </Card>
      </main>
    </div>
  );
}
