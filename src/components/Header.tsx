import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { useUserRole } from "@/hooks/useUserRole";
import { useNavigate } from "react-router-dom";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface HeaderProps {
  leftSlot?: React.ReactNode;
  rightSlot?: React.ReactNode;
}

export function Header({ leftSlot, rightSlot }: HeaderProps = {}) {
  const { user, signOut } = useAuth();
  const { roles, canManageUsers } = useUserRole();
  const navigate = useNavigate();
  const getInitials = (email: string) => email?.substring(0, 2).toUpperCase() || "U";
  const getRoleDisplay = () => {
    if (roles.includes("admin")) return "Admin";
    if (roles.includes("claims_manager")) return "Claims Manager";
    if (roles.includes("claims_reviewer")) return "Claims Reviewer";
    return "User";
  };

  return (
    <header className="bg-surface border-b border-outline-variant sticky top-0 z-40">
      <div className="flex items-center justify-between w-full px-6 h-16">
        <div className="flex items-center gap-4 min-w-0">{leftSlot}</div>

        <div className="flex items-center gap-3">
          {rightSlot}
          {canManageUsers() && (
            <Button
              variant="ghost"
              size="sm"
              className="gap-2 hidden sm:flex text-on-surface-variant"
              onClick={() => navigate("/admin")}
            >
              <Icon name="admin_panel_settings" size={18} />
              <span className="text-label-md">Admin</span>
            </Button>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="px-1 hover:bg-surface-container">
                <Avatar className="w-8 h-8">
                  <AvatarFallback className="text-[11px] bg-primary text-primary-foreground font-bold">
                    {getInitials(user?.email || "")}
                  </AvatarFallback>
                </Avatar>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>
                <div className="flex flex-col gap-1">
                  <span className="font-semibold text-on-surface">
                    {user?.user_metadata?.full_name || "Claims Reviewer"}
                  </span>
                  <span className="text-xs text-on-surface-variant font-normal">{user?.email}</span>
                  <Badge variant="outline" className="text-xs w-fit capitalize">
                    {getRoleDisplay()}
                  </Badge>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => navigate("/settings")}>
                <Icon name="person" size={18} className="mr-2" />
                Profile Settings
              </DropdownMenuItem>
              {canManageUsers() && (
                <DropdownMenuItem onClick={() => navigate("/admin")}>
                  <Icon name="manage_accounts" size={18} className="mr-2" />
                  User Management
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={signOut} className="text-destructive focus:text-destructive">
                <Icon name="logout" size={18} className="mr-2" />
                Sign Out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
