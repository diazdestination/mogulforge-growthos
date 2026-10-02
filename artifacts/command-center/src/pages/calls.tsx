import { VoiceDesk } from '@/components/voice-desk';
import { MissedCallCareDesk } from '@/components/missed-call-care-desk';
import { useState } from 'react';
import { useGetMe } from '@workspace/api-client-react';
import { canWrite } from '@/lib/permissions';

export default function Calls() {
  const [refreshToken, setRefreshToken] = useState(0);
  const { data: me } = useGetMe();
  return <main className="h-full overflow-auto p-4 md:p-6 max-w-5xl mx-auto space-y-4">
    <header>
      <h1 className="text-2xl font-bold">Calls and missed-call follow-up</h1>
      <p className="text-sm text-muted-foreground">Review missed callers, own the callback, and create an opportunity only when staff confirms it.</p>
    </header>
    <VoiceDesk canEdit={canWrite(me?.role)} onReviewed={() => setRefreshToken((value) => value + 1)} />
    <MissedCallCareDesk refreshToken={refreshToken} />
  </main>;
}
