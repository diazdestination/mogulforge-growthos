import { VoiceDesk } from '@/components/voice-desk';

export default function Calls() {
  return <main className="h-full overflow-auto p-4 md:p-6 max-w-5xl mx-auto space-y-4">
    <header>
      <h1 className="text-2xl font-bold">Calls and missed-call follow-up</h1>
      <p className="text-sm text-muted-foreground">Review missed callers, own the callback, and create an opportunity only when staff confirms it.</p>
    </header>
    <VoiceDesk />
  </main>;
}
