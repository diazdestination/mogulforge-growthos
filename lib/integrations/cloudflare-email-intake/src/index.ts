import PostalMime from "postal-mime";

interface Env {
  GROWTHOS_INTAKE_URL: string;
  INTAKE_DOMAIN: string;
  INTAKE_WEBHOOK_SECRET: string;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function extractOriginalSender(text: string): string | null {
  const forwardedBlock = /(?:^|\n)-{2,} forwarded message -{2,}[\s\S]*?\nfrom:\s*(?:[^<\n]*<)?([^<>\s]+@[^<>\s]+)>?/i.exec(text);
  return forwardedBlock?.[1]?.trim().toLowerCase() ?? null;
}

export function htmlToPlainText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[\t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function intakeAliasFor(recipient: string, domain: string): string | null {
  const normalized = recipient.trim().toLowerCase();
  const separator = normalized.lastIndexOf("@");
  if (separator <= 0 || normalized.slice(separator + 1) !== domain.trim().toLowerCase()) return null;
  const alias = normalized.slice(0, separator);
  return /^mf-[a-f0-9]{30}$/.test(alias) ? alias : null;
}

export async function signedHeaders(
  body: string,
  secret: string,
  timestamp = Math.floor(Date.now() / 1000),
): Promise<Record<string, string>> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  return {
    "content-type": "application/json",
    "x-mogulforge-signature": `t=${timestamp},v1=${bytesToHex(signature)}`,
  };
}

async function handleEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const alias = intakeAliasFor(message.to, env.INTAKE_DOMAIN);
  if (!alias) {
    message.setReject("Unknown MogulForge Email Intelligence recipient");
    return;
  }
  if (!env.INTAKE_WEBHOOK_SECRET || env.INTAKE_WEBHOOK_SECRET.length < 32) {
    throw new Error("INTAKE_WEBHOOK_SECRET is missing or too short");
  }
  const destination = new URL(env.GROWTHOS_INTAKE_URL);
  if (destination.protocol !== "https:") throw new Error("GROWTHOS_INTAKE_URL must use HTTPS");

  const rawEmail = await new Response(message.raw).arrayBuffer();
  const digest = bytesToHex(await crypto.subtle.digest("SHA-256", rawEmail));
  const parsed = await new PostalMime().parse(rawEmail);
  const text = parsed.text || htmlToPlainText(parsed.html || "");
  const body = JSON.stringify({
    externalMessageId: parsed.messageId || message.headers.get("message-id") || `sha256:${digest}`,
    forwardedBy: message.from,
    from: extractOriginalSender(text) || message.from,
    to: [message.to],
    subject: parsed.subject || message.headers.get("subject") || "",
    text,
    sentAt: parsed.date || null,
    attachmentCount: parsed.attachments.length,
  });
  const headers = await signedHeaders(body, env.INTAKE_WEBHOOK_SECRET);
  const endpoint = new URL(`/api/v1/public/email-intelligence/intake/${encodeURIComponent(alias)}`, destination);
  const response = await fetch(endpoint, { method: "POST", headers, body });
  if (response.status >= 500) {
    throw new Error(`GrowthOS intake temporarily failed with ${response.status}`);
  }
  // 4xx responses are permanent policy rejections (unknown/paused source,
  // unauthorized forwarder, oversized body, or attachment); do not retry and
  // do not log message content.
}

export default {
  async email(message, env): Promise<void> {
    await handleEmail(message, env);
  },
} satisfies ExportedHandler<Env>;
