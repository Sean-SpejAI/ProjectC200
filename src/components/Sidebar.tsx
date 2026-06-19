import { Icon } from "@/components/Icon";
import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";

interface SidebarProps {
  activeView: "analyze" | "upload" | "queue" | "completed" | "logic";
  onViewChange: (view: "analyze" | "upload" | "queue" | "completed" | "logic") => void;
  onNewAnalysis?: () => void;
}

export function Sidebar({ activeView, onViewChange, onNewAnalysis }: SidebarProps) {
  const navigate = useNavigate();
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    const fetchPendingCount = async () => {
      // Phase 2: only count claims that have actually been through the full
      // pipeline (synthesis completed). Old/parked/in-flight claims are
      // hidden from the queue, so the badge must match.
      const { count, error } = await supabase
        .from("claims")
        .select("*", { count: "exact", head: true })
        .in("status", ["pending", "in_review"])
        .eq("synthesis_status", "completed");
      if (error) {
        console.error("Error fetching pending count:", error);
        return;
      }
      setPendingCount(count || 0);
    };

    fetchPendingCount();

    const channel = supabase
      .channel("claims-count")
      .on("postgres_changes", { event: "*", schema: "public", table: "claims" }, () => {
        fetchPendingCount();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const navItem = (
    icon: string,
    label: string,
    view: SidebarProps["activeView"],
    badge?: number,
    filled?: boolean,
  ) => {
    const isActive = activeView === view;
    return (
      <button
        onClick={() => onViewChange(view)}
        className={cn(
          "w-full flex items-center gap-3 px-4 py-3 my-1 rounded-lg text-body-md transition-colors",
          isActive
            ? "bg-secondary-container text-on-secondary-container font-bold"
            : "text-on-surface-variant hover:bg-surface-container-high",
        )}
      >
        <Icon name={icon} size={20} filled={filled || isActive} />
        <span className="flex-grow text-left">{label}</span>
        {typeof badge === "number" && badge > 0 && (
          <span
            className={cn(
              "text-[10px] px-2 py-0.5 rounded-full font-bold",
              isActive
                ? "bg-on-secondary-container/15 text-on-secondary-container"
                : "bg-surface-container-highest text-primary",
            )}
          >
            {badge}
          </span>
        )}
      </button>
    );
  };

  return (
    <aside className="flex flex-col h-full w-[260px] py-4 bg-surface-container-lowest border-r border-outline-variant z-30 shrink-0">
      {/* Brand */}
      <div className="px-6 mb-8">
        <div className="flex items-center gap-3">
          <img src="/favicon.png" alt="Spej" className="w-10 h-10 rounded-lg object-contain" />
          <div>
            <h1 className="text-headline-sm text-primary leading-tight">Spej Claims</h1>
            <p className="text-label-md text-on-surface-variant opacity-70">Internal Review Portal</p>
          </div>
        </div>
      </div>

      {/* CTA */}
      <div className="px-4 mb-6">
        <button
          onClick={() => {
            if (onNewAnalysis) {
              onNewAnalysis();
            } else {
              onViewChange("analyze");
            }
          }}
          className="w-full bg-secondary text-secondary-foreground py-3 px-4 rounded-xl font-bold flex items-center justify-center gap-2 shadow-md hover:brightness-110 active:scale-95 transition-all"
        >
          <Icon name="add_circle" size={20} />
          New Analysis
        </button>
      </div>

      {/* Primary nav */}
      <nav className="flex-grow px-2">
        <p className="px-4 text-label-md text-outline uppercase tracking-widest mb-2">Claims Review</p>
        {navItem("list_alt", "Review Queue", "queue", pendingCount)}
        {navItem("check_circle", "Completed Reviews", "completed")}
      </nav>

      {/* Footer nav */}
      <div className="mt-auto border-t border-outline-variant pt-4 px-2">
        <button
          type="button"
          onClick={() => navigate("/settings")}
          className="w-full flex items-center gap-3 px-4 py-3 my-1 rounded-lg text-body-md text-on-surface-variant hover:bg-surface-container-high transition-colors"
        >
          <Icon name="settings" size={20} />
          <span className="flex-grow text-left">Settings</span>
        </button>

      </div>
    </aside>
  );
}
