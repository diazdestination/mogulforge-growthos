import { VoiceDesk } from '@/components/voice-desk';
import { MissedCallCareDesk } from '@/components/missed-call-care-desk';
import { useState } from 'react';
import { useGetMe } from '@workspace/api-client-react';
import { canWrite } from '@/lib/permissions';
import { CallieDesk } from '@/components/callie-desk';
import { memberAuthorityScope } from '@/lib/member-authority-scope';

export default function Calls() {
  const [refreshToken, setRefreshToken] = useState(0);
  const { data: me, isError, isLoading, refetch } = useGetMe();
  return <div className="h-full w-full min-w-0 overflow-auto p-4 md:p-6 max-w-5xl mx-auto space-y-4">
    <header>
      <h1 className="text-2xl font-bold">Calls and missed-call follow-up</h1>
      <p className="text-sm text-muted-foreground">Own the response, review what callers requested, and confirm visits only after the office agrees the details.</p>
    </header>
    {isError ? <div role="alert" className="rounded-lg border p-4 text-sm">Company access could not be verified. Call details and controls are unavailable until access is checked again. <button type="button" className="min-h-11 underline" onClick={() => void refetch()}>Check call access</button></div>
      : isLoading ? <p role="status">Confirming company access before opening calls…</p>
      : (!me?.isActive || !me.organization) && <p role="alert">Active company access is required to open calls.</p>}
    {!isError && me?.isActive && me.organization && <div key={memberAuthorityScope(me)} className="min-w-0 space-y-4">
      <CallieDesk refreshToken={refreshToken} />
      <details className="min-w-0 rounded-lg border bg-card p-4"><summary className="cursor-pointer font-semibold">Business calls and individually reviewed recovery</summary><div className="mt-4 min-w-0 space-y-4">
        <VoiceDesk canEdit={canWrite(me.role)} onReviewed={() => setRefreshToken((value) => value + 1)} />
        <MissedCallCareDesk refreshToken={refreshToken} />
      </div></details>
    </div>}
  </div>;
}
