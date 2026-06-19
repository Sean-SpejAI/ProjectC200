import { useState, useEffect } from "react";
import { Header } from "@/components/Header";
import { Sidebar } from "@/components/Sidebar";
import { supabase } from "@/integrations/supabase/client";
import { useUserRole } from "@/hooks/useUserRole";
import { useAuth } from "@/hooks/useAuth";
import { useNavigate } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { Icon } from "@/components/Icon";

type AppRole = "admin" | "claims_manager" | "claims_reviewer";

interface UserWithRoles {
  id: string;
  user_id: string;
  full_name: string | null;
  department: string | null;
  roles: AppRole[];
  mfaEnabled: boolean;
  isSuspended: boolean;
}

type PendingActionType =
  | "suspend"
  | "unsuspend"
  | "delete"
  | "reset_mfa"
  | "regenerate_codes";

interface PendingAction {
  type: PendingActionType;
  user: UserWithRoles;
}

interface NewUserDraft {
  email: string;
  fullName: string;
  department: string;
  initialRole: AppRole | "";
}

const EMPTY_NEW_USER: NewUserDraft = {
  email: "",
  fullName: "",
  department: "",
  initialRole: "",
};

export default function Admin() {
  const { canManageUsers, loading: roleLoading } = useUserRole();
  const { user: currentUser } = useAuth();
  const navigate = useNavigate();
  const [users, setUsers] = useState<UserWithRoles[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [isExecuting, setIsExecuting] = useState(false);
  // Confirmation token for the Delete action — admin must type the user's full
  // name (or "DELETE") to enable the destructive button.
  const [deleteConfirm, setDeleteConfirm] = useState("");
  // Plaintext backup codes returned by the regenerate action, shown once.
  const [generatedCodes, setGeneratedCodes] = useState<{ user: UserWithRoles; codes: string[] } | null>(null);
  // Create-user dialog state
  const [createUserOpen, setCreateUserOpen] = useState(false);
  const [newUser, setNewUser] = useState<NewUserDraft>(EMPTY_NEW_USER);
  const [isCreatingUser, setIsCreatingUser] = useState(false);
  // Reset-password dialog state — admin sets the new password directly.
  const [resetPasswordUser, setResetPasswordUser] = useState<UserWithRoles | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isSettingPassword, setIsSettingPassword] = useState(false);

  useEffect(() => {
    if (!roleLoading && !canManageUsers()) {
      toast.error("Access denied.");
      navigate("/");
    }
  }, [roleLoading, canManageUsers, navigate]);

  useEffect(() => {
    fetchUsers();
  }, []);

  const fetchUsers = async () => {
    setLoading(true);
    const { data: profiles, error } = await supabase
      .from("profiles")
      .select("id, user_id, full_name, department");
    if (error) {
      toast.error("Failed to fetch users");
      setLoading(false);
      return;
    }

    // Pull MFA + suspension status for every user in one shot (admin-gated RPC).
    const { data: statusRows } = await supabase.rpc("get_user_mfa_status");
    const statusByUser = new Map<string, { factorCount: number; isSuspended: boolean }>();
    (statusRows || []).forEach((r: { user_id: string; verified_factor_count: number; is_suspended: boolean }) => {
      statusByUser.set(r.user_id, {
        factorCount: Number(r.verified_factor_count),
        isSuspended: Boolean(r.is_suspended),
      });
    });

    const usersWithRoles: UserWithRoles[] = [];
    for (const profile of profiles || []) {
      const { data: roleData } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", profile.user_id);
      const status = statusByUser.get(profile.user_id);
      usersWithRoles.push({
        ...profile,
        roles: roleData?.map((r: any) => r.role) || [],
        mfaEnabled: (status?.factorCount ?? 0) > 0,
        isSuspended: status?.isSuspended ?? false,
      });
    }
    setUsers(usersWithRoles);
    setLoading(false);
  };

  const resetUserMFA = async (userId: string, displayName: string) => {
    const { data, error } = await supabase.functions.invoke("admin-reset-user-mfa", {
      body: { targetUserId: userId },
    });
    if (error || !data?.success) {
      toast.error(error?.message || "Failed to reset MFA");
      return;
    }
    toast.success(`MFA reset for ${displayName}`);
    fetchUsers();
  };

  const addRoleToUser = async (userId: string, role: AppRole) => {
    const { error } = await supabase.from("user_roles").insert({ user_id: userId, role });
    if (error) {
      toast.error(error.code === "23505" ? "User already has this role" : "Failed to add role");
      return;
    }
    toast.success("Role added");
    fetchUsers();
  };

  const removeRoleFromUser = async (userId: string, role: AppRole) => {
    const { error } = await supabase.from("user_roles").delete().eq("user_id", userId).eq("role", role);
    if (error) {
      toast.error("Failed to remove role");
      return;
    }
    toast.success("Role removed");
    fetchUsers();
  };

  const executePendingAction = async () => {
    if (!pendingAction) return;
    setIsExecuting(true);
    const { type, user } = pendingAction;
    const displayName = user.full_name || "user";
    try {
      if (type === "reset_mfa") {
        await resetUserMFA(user.user_id, displayName);
      } else if (type === "suspend" || type === "unsuspend" || type === "delete") {
        const { data, error } = await supabase.functions.invoke("admin-user-actions", {
          body: { action: type, targetUserId: user.user_id },
        });
        if (error || !data?.success) throw new Error(error?.message || "action failed");
        toast.success(
          type === "suspend"
            ? `${displayName} suspended`
            : type === "unsuspend"
              ? `${displayName} reinstated`
              : `${displayName} deleted`,
        );
        await fetchUsers();
      } else if (type === "regenerate_codes") {
        const { data, error } = await supabase.functions.invoke("admin-regenerate-backup-codes", {
          body: { targetUserId: user.user_id },
        });
        if (error || !data?.success) throw new Error(error?.message || "regenerate failed");
        setGeneratedCodes({ user, codes: data.codes as string[] });
        toast.success(`Generated 10 new backup codes for ${displayName}`);
      }
    } catch (err: any) {
      toast.error(err.message || "Action failed");
    } finally {
      setIsExecuting(false);
      setPendingAction(null);
      setDeleteConfirm("");
    }
  };

  const generateStrongPassword = (): string => {
    // 20 chars, alphanumeric + a few safe symbols. Uses crypto.getRandomValues
    // for entropy. Avoids ambiguous chars (0/O, 1/l/I) so the value is easy to
    // read aloud or paste from a chat.
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^&*";
    const arr = new Uint32Array(20);
    crypto.getRandomValues(arr);
    let out = "";
    for (const n of arr) out += alphabet[n % alphabet.length];
    return out;
  };

  const submitResetPassword = async () => {
    if (!resetPasswordUser) return;
    if (newPassword.length < 8) {
      toast.error("Password must be at least 8 characters.");
      return;
    }
    setIsSettingPassword(true);
    try {
      const { data, error } = await supabase.functions.invoke("admin-user-actions", {
        body: {
          action: "set_password",
          targetUserId: resetPasswordUser.user_id,
          newPassword,
        },
      });
      if (error || !data?.success) {
        // supabase-js v2 wraps non-2xx responses in FunctionsHttpError and
        // hides the body. Reach into error.context.response to get the real
        // message the function returned.
        let detail = (data as any)?.message || error?.message || "Failed to set password";
        const ctxResp = (error as any)?.context?.response as Response | undefined;
        if (ctxResp) {
          try {
            const body = await ctxResp.clone().json();
            if (body?.message) detail = body.message;
            else if (body?.error) detail = body.error;
          } catch {
            try {
              const text = await ctxResp.clone().text();
              if (text) detail = text.slice(0, 300);
            } catch { /* keep fallback */ }
          }
        }
        throw new Error(detail);
      }
      toast.success(
        `Password reset for ${resetPasswordUser.full_name || "user"}. Share it with them via a secure channel.`,
      );
      setResetPasswordUser(null);
      setNewPassword("");
      setShowPassword(false);
    } catch (err: any) {
      toast.error(err.message || "Failed to set password");
    } finally {
      setIsSettingPassword(false);
    }
  };

  const submitCreateUser = async () => {
    const email = newUser.email.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toast.error("Enter a valid email address.");
      return;
    }
    setIsCreatingUser(true);
    try {
      const { data, error } = await supabase.functions.invoke("admin-user-actions", {
        body: {
          action: "create_user",
          email,
          fullName: newUser.fullName.trim() || undefined,
          department: newUser.department.trim() || undefined,
          initialRole: newUser.initialRole || undefined,
          origin: window.location.origin,
        },
      });
      if (error || !data?.success) {
        // The function returns { error, message } for invite failures
        const detail = (data as any)?.message || error?.message || "Failed to create user";
        throw new Error(detail);
      }
      toast.success(`Invite sent to ${email}`);
      setCreateUserOpen(false);
      setNewUser(EMPTY_NEW_USER);
      await fetchUsers();
    } catch (err: any) {
      toast.error(err.message || "Failed to create user");
    } finally {
      setIsCreatingUser(false);
    }
  };

  const copyAllCodes = async () => {
    if (!generatedCodes) return;
    await navigator.clipboard.writeText(generatedCodes.codes.join("\n"));
    toast.success("Codes copied to clipboard");
  };

  const getRoleBadgeVariant = (role: AppRole) => {
    switch (role) {
      case "admin":
        return "destructive" as const;
      case "claims_manager":
        return "default" as const;
      default:
        return "secondary" as const;
    }
  };

  if (roleLoading || loading)
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Icon name="progress_activity" size={32} className="animate-spin text-primary" />
      </div>
    );

  return (
    <div className="bg-background text-on-surface flex h-screen overflow-hidden">
      <div className="hidden lg:block">
        <Sidebar activeView="analyze" onViewChange={() => navigate("/")} />
      </div>
      <main className="flex-grow flex flex-col min-w-0 overflow-hidden">
        <Header />
        <div className="flex-1 overflow-y-auto p-6 lg:p-10">
          <div className="max-w-5xl">
            <div className="flex items-center justify-between mb-8">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-primary-container text-on-primary-container flex items-center justify-center">
                  <Icon name="admin_panel_settings" size={20} filled />
                </div>
                <div>
                  <h1 className="text-headline-md text-primary">User Management</h1>
                  <p className="text-body-md text-on-surface-variant">Manage user roles and permissions</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Badge
                  variant="outline"
                  className="gap-1 px-3 py-1.5 bg-surface-container-low border-outline-variant rounded-full"
                >
                  <Icon name="group" size={14} />
                  {users.length} users
                </Badge>
                <Button
                  size="sm"
                  className="gap-2"
                  onClick={() => {
                    setNewUser(EMPTY_NEW_USER);
                    setCreateUserOpen(true);
                  }}
                >
                  <Icon name="person_add" size={16} />
                  Create user
                </Button>
              </div>
            </div>
            <Card className="bg-surface-container-lowest border-outline-variant shadow-elevation-1 rounded-2xl overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="bg-surface-container-low/50 hover:bg-surface-container-low/50">
                    <TableHead className="text-label-md uppercase tracking-widest text-on-surface-variant">
                      User
                    </TableHead>
                    <TableHead className="text-label-md uppercase tracking-widest text-on-surface-variant">
                      Department
                    </TableHead>
                    <TableHead className="text-label-md uppercase tracking-widest text-on-surface-variant">
                      Roles
                    </TableHead>
                    <TableHead className="text-label-md uppercase tracking-widest text-on-surface-variant">
                      MFA
                    </TableHead>
                    <TableHead className="text-label-md uppercase tracking-widest text-on-surface-variant text-right">
                      Actions
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.map((user) => (
                    <TableRow key={user.id} className="hover:bg-surface-container-low transition-colors">
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center">
                            <span className="text-xs font-bold">
                              {user.full_name?.charAt(0)?.toUpperCase() || "U"}
                            </span>
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <p className="text-body-md font-semibold text-on-surface">
                                {user.full_name || "Unnamed User"}
                              </p>
                              {user.isSuspended && (
                                <Badge
                                  variant="outline"
                                  className="rounded-full bg-destructive/10 text-destructive border-destructive/30 gap-1 text-[10px]"
                                >
                                  <Icon name="block" size={10} filled />
                                  Suspended
                                </Badge>
                              )}
                            </div>
                            <p className="text-[10px] text-on-surface-variant font-mono">
                              {user.user_id.slice(0, 8)}...
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="text-body-md text-on-surface-variant">
                          {user.department || "Claims"}
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1">
                          {user.roles.length === 0 ? (
                            <Badge
                              variant="outline"
                              className="rounded-full bg-warning/10 text-warning border-warning/30 gap-1.5"
                            >
                              <Icon name="hourglass_empty" size={12} filled />
                              Pending approval
                            </Badge>
                          ) : (
                            user.roles.map((role) => (
                              <Badge
                                key={role}
                                variant={getRoleBadgeVariant(role)}
                                className="text-xs capitalize rounded-full"
                              >
                                {role.replace("_", " ")}
                                <AlertDialog>
                                  <AlertDialogTrigger asChild>
                                    <button className="ml-1 inline-flex items-center">
                                      <Icon name="close" size={12} />
                                    </button>
                                  </AlertDialogTrigger>
                                  <AlertDialogContent>
                                    <AlertDialogHeader>
                                      <AlertDialogTitle>Remove Role</AlertDialogTitle>
                                      <AlertDialogDescription>
                                        Remove "{role.replace("_", " ")}" from this user?
                                      </AlertDialogDescription>
                                    </AlertDialogHeader>
                                    <AlertDialogFooter>
                                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                                      <AlertDialogAction
                                        onClick={() => removeRoleFromUser(user.user_id, role)}
                                      >
                                        Remove
                                      </AlertDialogAction>
                                    </AlertDialogFooter>
                                  </AlertDialogContent>
                                </AlertDialog>
                              </Badge>
                            ))
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        {user.mfaEnabled ? (
                          <Badge className="rounded-full bg-success/15 text-success border-success/30 gap-1.5">
                            <Icon name="verified_user" size={12} filled />
                            Enabled
                          </Badge>
                        ) : (
                          <Badge
                            variant="outline"
                            className="rounded-full text-on-surface-variant border-outline-variant"
                          >
                            Not set up
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          {user.roles.length === 0 && (
                            <button
                              onClick={() => addRoleToUser(user.user_id, "claims_reviewer")}
                              className="text-label-md text-success hover:brightness-110 transition-colors inline-flex items-center gap-1 font-semibold"
                              title="Approve this user (grants Claims Reviewer)"
                            >
                              <Icon name="check_circle" size={16} filled />
                              Approve
                            </button>
                          )}
                          <Select onValueChange={(v) => addRoleToUser(user.user_id, v as AppRole)}>
                            <SelectTrigger className="w-36">
                              <SelectValue placeholder="Add role..." />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="admin">Admin</SelectItem>
                              <SelectItem value="claims_manager">Claims Manager</SelectItem>
                              <SelectItem value="claims_reviewer">Claims Reviewer</SelectItem>
                            </SelectContent>
                          </Select>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="text-on-surface-variant"
                                title="More actions"
                                disabled={currentUser?.id === user.user_id}
                              >
                                <Icon name="more_vert" size={18} />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-52">
                              <DropdownMenuItem
                                onClick={() => {
                                  setNewPassword("");
                                  setShowPassword(false);
                                  setResetPasswordUser(user);
                                }}
                              >
                                <Icon name="key" size={16} className="mr-2" />
                                Reset password
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              {user.mfaEnabled && (
                                <>
                                  <DropdownMenuItem
                                    onClick={() => setPendingAction({ type: "regenerate_codes", user })}
                                  >
                                    <Icon name="vpn_key" size={16} className="mr-2" />
                                    Regenerate backup codes
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    onClick={() => setPendingAction({ type: "reset_mfa", user })}
                                  >
                                    <Icon name="lock_reset" size={16} className="mr-2" />
                                    Reset MFA
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                </>
                              )}
                              {user.isSuspended ? (
                                <DropdownMenuItem
                                  onClick={() => setPendingAction({ type: "unsuspend", user })}
                                >
                                  <Icon name="lock_open" size={16} className="mr-2" />
                                  Reinstate user
                                </DropdownMenuItem>
                              ) : (
                                <DropdownMenuItem
                                  onClick={() => setPendingAction({ type: "suspend", user })}
                                >
                                  <Icon name="block" size={16} className="mr-2" />
                                  Suspend user
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem
                                onClick={() => setPendingAction({ type: "delete", user })}
                                className="text-destructive focus:text-destructive"
                              >
                                <Icon name="delete" size={16} className="mr-2" />
                                Delete user
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          </div>
        </div>
      </main>

      {/* Unified confirmation dialog for destructive admin actions. */}
      <AlertDialog
        open={pendingAction !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingAction(null);
            setDeleteConfirm("");
          }
        }}
      >
        <AlertDialogContent>
          {pendingAction && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {pendingAction.type === "suspend" && "Suspend user?"}
                  {pendingAction.type === "unsuspend" && "Reinstate user?"}
                  {pendingAction.type === "delete" && "Permanently delete user?"}
                  {pendingAction.type === "reset_mfa" && "Reset MFA?"}
                  {pendingAction.type === "regenerate_codes" && "Regenerate backup codes?"}
                </AlertDialogTitle>
                <AlertDialogDescription asChild>
                  <div className="space-y-3">
                    {pendingAction.type === "suspend" && (
                      <p>
                        <strong>{pendingAction.user.full_name || "This user"}</strong> won't be able
                        to sign in until you reinstate them. Their data is preserved.
                      </p>
                    )}
                    {pendingAction.type === "unsuspend" && (
                      <p>
                        <strong>{pendingAction.user.full_name || "This user"}</strong> will be able
                        to sign in again.
                      </p>
                    )}
                    {pendingAction.type === "delete" && (
                      <>
                        <p>
                          <strong>This cannot be undone.</strong>{" "}
                          {pendingAction.user.full_name || "This user"}'s account, profile, roles,
                          and MFA credentials will be permanently removed.
                        </p>
                        <div className="space-y-1.5">
                          <label className="text-xs text-on-surface-variant">
                            Type <strong>DELETE</strong> to confirm:
                          </label>
                          <Input
                            value={deleteConfirm}
                            onChange={(e) => setDeleteConfirm(e.target.value)}
                            placeholder="DELETE"
                            autoFocus
                          />
                        </div>
                      </>
                    )}
                    {pendingAction.type === "reset_mfa" && (
                      <p>
                        This clears the authenticator factor and backup codes for{" "}
                        <strong>{pendingAction.user.full_name || "this user"}</strong>. On their
                        next sign-in they'll be forced to enroll a new authenticator app.
                      </p>
                    )}
                    {pendingAction.type === "regenerate_codes" && (
                      <p>
                        Generates 10 new backup codes for{" "}
                        <strong>{pendingAction.user.full_name || "this user"}</strong>. Their old
                        codes stop working immediately. The new codes will be shown once — relay
                        them via a secure channel.
                      </p>
                    )}
                  </div>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={isExecuting}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={(e) => {
                    e.preventDefault();
                    executePendingAction();
                  }}
                  disabled={
                    isExecuting ||
                    (pendingAction.type === "delete" && deleteConfirm !== "DELETE")
                  }
                  className={
                    pendingAction.type === "delete" || pendingAction.type === "suspend"
                      ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      : undefined
                  }
                >
                  {isExecuting ? (
                    <>
                      <Icon name="progress_activity" size={14} className="mr-2 animate-spin" />
                      Working...
                    </>
                  ) : (
                    {
                      suspend: "Suspend",
                      unsuspend: "Reinstate",
                      delete: "Delete forever",
                      reset_mfa: "Reset MFA",
                      regenerate_codes: "Generate codes",
                    }[pendingAction.type]
                  )}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>

      {/* Reset password dialog. Admin enters (or generates) a new password
          and writes it through admin-user-actions → auth.admin.updateUserById.
          Admin is responsible for relaying the value to the user out-of-band.
          The value is visible in the input so the admin can read or copy it;
          a show/hide toggle is provided for shoulder-surf scenarios. */}
      <Dialog
        open={resetPasswordUser !== null}
        onOpenChange={(open) => {
          if (!open && !isSettingPassword) {
            setResetPasswordUser(null);
            setNewPassword("");
            setShowPassword(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset password</DialogTitle>
            <DialogDescription>
              {resetPasswordUser && (
                <>
                  Set a new password for{" "}
                  <strong>{resetPasswordUser.full_name || "this user"}</strong>. Their old password
                  stops working immediately. You'll need to share the new value with them via a
                  secure channel — we don't save or echo it after this dialog closes.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <label className="text-xs text-on-surface-variant">New password</label>
            <div className="flex items-center gap-2">
              <Input
                type={showPassword ? "text" : "password"}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Type or generate a password"
                autoFocus
                disabled={isSettingPassword}
                className="font-mono"
              />
              <Button
                variant="outline"
                size="icon"
                type="button"
                onClick={() => setShowPassword((s) => !s)}
                disabled={isSettingPassword}
                title={showPassword ? "Hide" : "Show"}
              >
                <Icon name={showPassword ? "visibility_off" : "visibility"} size={16} />
              </Button>
              <Button
                variant="outline"
                size="icon"
                type="button"
                onClick={() => {
                  setNewPassword(generateStrongPassword());
                  setShowPassword(true);
                }}
                disabled={isSettingPassword}
                title="Generate a strong random password"
              >
                <Icon name="autorenew" size={16} />
              </Button>
              <Button
                variant="outline"
                size="icon"
                type="button"
                onClick={async () => {
                  if (!newPassword) return;
                  try {
                    await navigator.clipboard.writeText(newPassword);
                    toast.success("Password copied to clipboard");
                  } catch {
                    toast.error("Could not copy to clipboard");
                  }
                }}
                disabled={isSettingPassword || !newPassword}
                title="Copy to clipboard"
              >
                <Icon name="content_copy" size={16} />
              </Button>
            </div>
            <p className="text-[11px] text-on-surface-variant">
              Minimum 8 characters. Click the refresh icon to generate a strong random value.
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={isSettingPassword}
              onClick={() => {
                setResetPasswordUser(null);
                setNewPassword("");
                setShowPassword(false);
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={submitResetPassword}
              disabled={isSettingPassword || newPassword.length < 8}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isSettingPassword ? (
                <>
                  <Icon name="progress_activity" size={14} className="mr-2 animate-spin" />
                  Setting...
                </>
              ) : (
                <>
                  <Icon name="key" size={14} className="mr-2" />
                  Set new password
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create user dialog. Submits to admin-user-actions which calls
          inviteUserByEmail — the user gets an invite email through the
          existing auth-hook → send-email pipeline and sets their own
          password from the link inside. We never see the password. */}
      <Dialog
        open={createUserOpen}
        onOpenChange={(open) => {
          if (!open && !isCreatingUser) {
            setCreateUserOpen(false);
            setNewUser(EMPTY_NEW_USER);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create user</DialogTitle>
            <DialogDescription>
              Sends an invite email. The user clicks the link to set their own password — you
              never see it. Optionally seed a starting role so they land on a working portal
              instead of "Pending approval".
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <label className="text-xs text-on-surface-variant">
                Email <span className="text-destructive">*</span>
              </label>
              <Input
                type="email"
                value={newUser.email}
                onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
                placeholder="user@example.com"
                autoFocus
                disabled={isCreatingUser}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-on-surface-variant">Full name</label>
              <Input
                value={newUser.fullName}
                onChange={(e) => setNewUser({ ...newUser, fullName: e.target.value })}
                placeholder="Jane Smith"
                disabled={isCreatingUser}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-on-surface-variant">Department</label>
              <Input
                value={newUser.department}
                onChange={(e) => setNewUser({ ...newUser, department: e.target.value })}
                placeholder="Claims"
                disabled={isCreatingUser}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-on-surface-variant">
                Initial role <span className="text-on-surface-variant">(optional)</span>
              </label>
              <Select
                value={newUser.initialRole || "__none__"}
                onValueChange={(v) =>
                  setNewUser({
                    ...newUser,
                    initialRole: v === "__none__" ? "" : (v as AppRole),
                  })
                }
                disabled={isCreatingUser}
              >
                <SelectTrigger>
                  <SelectValue placeholder="None (pending approval)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">None (pending approval)</SelectItem>
                  <SelectItem value="claims_reviewer">Claims Reviewer</SelectItem>
                  <SelectItem value="claims_manager">Claims Manager</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={isCreatingUser}
              onClick={() => {
                setCreateUserOpen(false);
                setNewUser(EMPTY_NEW_USER);
              }}
            >
              Cancel
            </Button>
            <Button onClick={submitCreateUser} disabled={isCreatingUser || !newUser.email.trim()}>
              {isCreatingUser ? (
                <>
                  <Icon name="progress_activity" size={14} className="mr-2 animate-spin" />
                  Sending invite...
                </>
              ) : (
                <>
                  <Icon name="send" size={14} className="mr-2" />
                  Send invite
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* One-time display of newly-generated backup codes. */}
      <Dialog
        open={generatedCodes !== null}
        onOpenChange={(open) => {
          if (!open) setGeneratedCodes(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New backup codes</DialogTitle>
            <DialogDescription>
              {generatedCodes && (
                <>
                  10 new single-use codes for{" "}
                  <strong>{generatedCodes.user.full_name || "this user"}</strong>. The user's
                  previous codes no longer work. <strong>This is the only time these codes will
                  be shown.</strong> Relay them via a secure channel.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {generatedCodes && (
            <div className="grid grid-cols-2 gap-2 font-mono text-sm bg-surface-container-low rounded-xl p-4 border border-outline-variant">
              {generatedCodes.codes.map((c) => (
                <code key={c} className="select-all text-on-surface">
                  {c}
                </code>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={copyAllCodes}>
              <Icon name="content_copy" size={16} className="mr-2" />
              Copy all
            </Button>
            <Button onClick={() => setGeneratedCodes(null)}>I have these codes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
