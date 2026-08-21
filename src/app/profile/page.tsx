import { prisma } from "@/lib/prisma";
import { shortDate } from "@/lib/dates";
import { requireUser } from "@/server/security/tenant-context";
import {
  updateProfileAction,
  changePasswordAction,
} from "@/server/actions/profile-actions";
import { AppShell } from "@/components/layout/app-shell";
import { ActionForm } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

export default async function ProfilePage() {
  const { userId, email } = await requireUser();

  const [user, membership] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { name: true, email: true, createdAt: true, passwordHash: true },
    }),
    prisma.workspaceMember.findFirst({
      where: { userId },
      select: { role: true, workspace: { select: { name: true } } },
    }),
  ]);

  return (
    <AppShell>
      <div className="mx-auto max-w-2xl space-y-6 p-6">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            Profile
          </h1>
          <p className="text-sm text-muted-foreground">
            Manage your account and security settings.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Account</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <ActionForm
              action={updateProfileAction}
              successMessage="Name updated"
              className="space-y-2"
            >
              <Label htmlFor="name">Full name</Label>
              <div className="flex gap-2">
                <Input
                  id="name"
                  name="name"
                  defaultValue={user.name ?? ""}
                  placeholder="Your name"
                  className="max-w-sm"
                />
                <SubmitButton variant="outline">Save</SubmitButton>
              </div>
            </ActionForm>

            <Separator />

            <div className="space-y-1">
              <Label className="text-muted-foreground">Email</Label>
              <p className="text-sm">{user.email ?? email ?? "—"}</p>
            </div>

            <div className="space-y-1">
              <Label className="text-muted-foreground">Member since</Label>
              <p className="text-sm">{shortDate(user.createdAt)}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Workspace</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <Label className="text-muted-foreground">Workspace</Label>
              <p className="text-sm">{membership?.workspace.name ?? "—"}</p>
            </div>
            <div className="space-y-1">
              <Label className="text-muted-foreground">Role</Label>
              <div>
                <Badge variant="secondary">{membership?.role ?? "—"}</Badge>
              </div>
            </div>
          </CardContent>
        </Card>

        {user.passwordHash ? (
          <Card>
            <CardHeader>
              <CardTitle>Change password</CardTitle>
            </CardHeader>
            <CardContent>
              <ActionForm
                action={changePasswordAction}
                successMessage="Password updated"
                className="max-w-sm space-y-4"
              >
                <div className="space-y-2">
                  <Label htmlFor="currentPassword">Current password</Label>
                  <Input
                    id="currentPassword"
                    name="currentPassword"
                    type="password"
                    autoComplete="current-password"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="newPassword">New password</Label>
                  <Input
                    id="newPassword"
                    name="newPassword"
                    type="password"
                    autoComplete="new-password"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="confirmPassword">Confirm new password</Label>
                  <Input
                    id="confirmPassword"
                    name="confirmPassword"
                    type="password"
                    autoComplete="new-password"
                  />
                </div>
                <SubmitButton variant="outline">Update password</SubmitButton>
              </ActionForm>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </AppShell>
  );
}
