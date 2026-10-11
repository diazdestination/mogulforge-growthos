export type SpecialistKey = 'scout' | 'invo' | 'assistant';

export const specialistNames: Record<SpecialistKey, string> = { scout: 'SCOUT', invo: 'INVO', assistant: 'Assistant' };

/** Labels a queue row with the specialist that proposed it. Specialists can only propose. */
export function SpecialistBadge({ specialist }: { specialist?: string | null }) {
  if (!specialist || !(specialist in specialistNames)) return null;
  return (
    <span
      className="rounded-full border border-primary/30 bg-primary/5 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary"
      title="Proposed by a specialist. Nothing runs until staff approve it."
    >
      {specialistNames[specialist as SpecialistKey]}
    </span>
  );
}
