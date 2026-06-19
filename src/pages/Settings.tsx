import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Icon } from "@/components/Icon";
import { MFAEnroll } from "@/components/MFAEnroll";
import { Header } from "@/components/Header";
import { Sidebar } from "@/components/Sidebar";

export default function Settings() {
  const navigate = useNavigate();
  const { user } = useAuth();

  return (
    <div className="bg-background text-on-surface flex h-screen overflow-hidden">
      <div className="hidden lg:block">
        <Sidebar activeView="analyze" onViewChange={() => navigate("/")} />
      </div>
      <main className="flex-grow flex flex-col min-w-0 overflow-hidden">
        <Header />
        <div className="flex-1 overflow-y-auto p-6 lg:p-10">
          <div className="max-w-2xl">
            <h1 className="text-headline-md text-primary mb-8">Account Settings</h1>
            <div className="space-y-6">
              <Card className="p-6 bg-surface-container-lowest border-outline-variant shadow-elevation-1 rounded-2xl">
                <div className="flex items-center gap-3 mb-5">
                  <div className="w-10 h-10 rounded-lg bg-primary-container text-on-primary-container flex items-center justify-center">
                    <Icon name="person" size={20} filled />
                  </div>
                  <div>
                    <h3 className="text-headline-sm text-primary">Profile</h3>
                    <p className="text-body-md text-on-surface-variant">Your account information</p>
                  </div>
                </div>
                <div className="space-y-3">
                  <div>
                    <p className="text-label-md text-on-surface-variant uppercase mb-1">Email</p>
                    <p className="text-body-lg font-semibold text-on-surface">{user?.email}</p>
                  </div>
                </div>
              </Card>
              <Separator className="bg-outline-variant" />
              <div>
                <div className="flex items-center gap-3 mb-5">
                  <div className="w-10 h-10 rounded-lg bg-secondary/10 text-secondary flex items-center justify-center">
                    <Icon name="security" size={20} filled />
                  </div>
                  <div>
                    <h2 className="text-headline-sm text-primary">Security</h2>
                    <p className="text-body-md text-on-surface-variant">
                      Two-factor authentication is required for this app. Contact an admin if you
                      need to reset your authenticator or backup codes.
                    </p>
                  </div>
                </div>
                <MFAEnroll onComplete={() => {}} />
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
