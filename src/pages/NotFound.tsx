import { useLocation } from "react-router-dom";
import { useEffect } from "react";
import { Icon } from "@/components/Icon";

const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    console.error("404 Error: User attempted to access non-existent route:", location.pathname);
  }, [location.pathname]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="text-center max-w-md">
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-secondary text-secondary-foreground mb-6 shadow-elevation-1">
          <Icon name="error" size={40} filled />
        </div>
        <h1 className="text-display-lg text-primary mb-3">404</h1>
        <p className="text-body-lg text-on-surface-variant mb-8">Oops! That page doesn't exist.</p>
        <a
          href="/"
          className="inline-flex items-center gap-2 bg-primary text-primary-foreground px-5 py-3 rounded-xl font-semibold hover:brightness-110 transition-all"
        >
          <Icon name="arrow_back" size={18} />
          Return to Home
        </a>
      </div>
    </div>
  );
};

export default NotFound;
