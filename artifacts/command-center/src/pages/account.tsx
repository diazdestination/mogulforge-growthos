import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getGetMeQueryKey, useGetMe } from '@workspace/api-client-react';
import { Loader2, UserRound } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { GmailConnectionCard } from '@/components/gmail-connection-card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';

export default function Account() {
  const { data: profile, isLoading } = useGetMe();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [saving, setSaving] = useState(false);
  const gmailReturn = new URLSearchParams(window.location.search).get('gmail');

  useEffect(() => {
    if (!profile) return;
    setFirstName(profile.firstName ?? '');
    setLastName(profile.lastName ?? '');
  }, [profile]);

  async function saveProfile(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const response = await fetch('/api/v1/me', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName, lastName }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? 'Could not update your profile.');
      }
      await queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
      toast({
        title: 'Profile updated',
        description: 'Your name is now updated throughout GrowthOS.',
      });
    } catch (error) {
      toast({
        title: 'Could not update profile',
        description: error instanceof Error ? error.message : 'Please try again.',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">My Profile</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage your personal details and the accounts GrowthOS uses on your behalf.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <UserRound className="h-5 w-5" />
            </div>
            <div>
              <CardTitle>Personal details</CardTitle>
              <CardDescription>
                Your role and organization stay protected and cannot be changed here.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={saveProfile} className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="profile-first-name">First name</Label>
                <Input
                  id="profile-first-name"
                  value={firstName}
                  onChange={(event) => setFirstName(event.target.value)}
                  maxLength={100}
                  autoComplete="given-name"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="profile-last-name">Last name</Label>
                <Input
                  id="profile-last-name"
                  value={lastName}
                  onChange={(event) => setLastName(event.target.value)}
                  maxLength={100}
                  autoComplete="family-name"
                />
              </div>
            </div>

            <div className="rounded-lg border bg-muted/30 px-4 py-3 text-sm">
              <div className="font-medium">{profile?.email}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {profile?.organization?.name} · {profile?.role.replace('_', ' ')}
              </div>
            </div>

            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save profile
            </Button>
          </form>
        </CardContent>
      </Card>

      <section aria-labelledby="my-connections-heading" className="space-y-4">
        <div>
          <h2 id="my-connections-heading" className="text-xl font-semibold tracking-tight">My Connections</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            These connections belong to your user account. They never grant access to organization settings or another team member's mailbox.
          </p>
        </div>
        <GmailConnectionCard callbackState={gmailReturn} returnPath="/account" />
      </section>
    </div>
  );
}
