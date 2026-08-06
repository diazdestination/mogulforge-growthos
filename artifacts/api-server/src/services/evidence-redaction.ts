export type RedactionKind = "email" | "phone" | "ssn" | "policy";

export type RedactionResult = {
  text: string;
  counts: Record<RedactionKind, number>;
};

const RULES: Array<{ kind: RedactionKind; pattern: RegExp; replacement: string }> = [
  {
    kind: "email",
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    replacement: "[REDACTED_EMAIL]",
  },
  {
    kind: "ssn",
    pattern: /\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/g,
    replacement: "[REDACTED_SSN]",
  },
  {
    kind: "phone",
    pattern: /(?<!\d)(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]?\d{3}[-.\s]?\d{4}(?!\d)/g,
    replacement: "[REDACTED_PHONE]",
  },
  {
    kind: "policy",
    pattern: /\b(?:policy|claim|account)\s*(?:number|no\.?|#|id)?\s*[:#-]?\s*[A-Z0-9][A-Z0-9-]{5,}\b/gi,
    replacement: "[REDACTED_POLICY_ID]",
  },
];

/** Redacts common direct identifiers before text is eligible for model input. */
export function redactEvidenceText(input: string): RedactionResult {
  const counts: Record<RedactionKind, number> = { email: 0, phone: 0, ssn: 0, policy: 0 };
  let text = input;

  for (const rule of RULES) {
    text = text.replace(rule.pattern, () => {
      counts[rule.kind] += 1;
      return rule.replacement;
    });
  }

  return { text, counts };
}
