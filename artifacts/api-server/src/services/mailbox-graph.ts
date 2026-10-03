import { isSafeMailbox } from "./providers";
import {
  MAILBOX_HEADER,
  MAILBOX_MAX_BODY,
  MAILBOX_PAGE_SIZE,
  MailboxError,
  mailboxDigest,
  type MailboxMessage,
} from "./mailbox-contract";

export type MailboxFolder = "inbox" | "sentitems";
export type FolderCursor = {
  folderId: string;
  continuation: string | null;
  complete: boolean;
};
export type MailboxCursors = Record<MailboxFolder, FolderCursor>;
const GRAPH = "https://graph.microsoft.com/v1.0";
const fields =
  "id,internetMessageId,from,toRecipients,subject,sentDateTime,receivedDateTime,internetMessageHeaders,isDraft";
export type MailboxRejectedMessage = {
  providerMessageId: string;
  contentSha256: string;
  reason: string;
};
export const mailboxMetadataDigest = (message: MailboxMessage) =>
  mailboxDigest({ ...message, text: "" });
const identifier = (id: unknown): id is string =>
  typeof id === "string" && /^[A-Za-z0-9_+=/-]{1,1024}$/.test(id);
const object = (x: unknown): Record<string, unknown> =>
  x && typeof x === "object" && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : {};
export const immutableHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  Prefer: `IdType="ImmutableId", outlook.body-content-type="text", odata.maxpagesize=${MAILBOX_PAGE_SIZE}`,
});

/** Bounded response parsing; never logs bodies, credentials or opaque tokens. */
export async function mailboxJson(
  response: Response,
  max = 512_000,
): Promise<Record<string, unknown>> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new MailboxError(
      response.status === 410
        ? "mailbox_cursor_gap"
        : [401, 403].includes(response.status)
          ? "mailbox_read_revoked"
          : response.status === 429
            ? "mailbox_rate_limited"
            : "mailbox_provider_unavailable",
      503,
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new MailboxError("mailbox_invalid_response");
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > max) {
        await reader.cancel();
        throw new MailboxError("mailbox_response_too_large");
      }
      chunks.push(next.value);
    }
    return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch (error) {
    if (error instanceof MailboxError) throw error;
    throw new MailboxError("mailbox_invalid_response");
  }
}
async function get(url: string, token: string, transport: typeof fetch) {
  try {
    return await mailboxJson(
      await transport(url, {
        method: "GET",
        headers: immutableHeaders(token),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      }),
    );
  } catch (error) {
    if (error instanceof MailboxError) throw error;
    throw new MailboxError("mailbox_provider_unavailable", 503);
  }
}
export async function readMailboxProfile(
  token: string,
  transport: typeof fetch = fetch,
) {
  const profile = await get(
    `${GRAPH}/me?$select=id,mail,userPrincipalName`,
    token,
    transport,
  );
  const email = String(profile.mail ?? profile.userPrincipalName ?? "")
    .trim()
    .toLowerCase();
  if (!identifier(profile.id) || !isSafeMailbox(email))
    throw new MailboxError("mailbox_identity_invalid");
  return { accountId: profile.id, email };
}
export async function readMailboxFolders(
  token: string,
  transport: typeof fetch = fetch,
  beforeRead?: () => Promise<void>,
): Promise<MailboxCursors> {
  const folder = async (name: MailboxFolder) => {
    await beforeRead?.();
    const result = await get(
      `${GRAPH}/me/mailFolders/${name}?$select=id`,
      token,
      transport,
    );
    if (!identifier(result.id))
      throw new MailboxError("mailbox_folder_invalid");
    return { folderId: result.id, continuation: null, complete: false };
  };
  return { inbox: await folder("inbox"), sentitems: await folder("sentitems") };
}
export function validateMailboxContinuation(
  raw: string,
  folderId: string,
  accountId: string,
) {
  if (raw.length > 16_384 || !identifier(folderId) || !identifier(accountId))
    throw new MailboxError("mailbox_cursor_invalid");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MailboxError("mailbox_cursor_invalid");
  }
  const paths = [
    `/v1.0/me/mailFolders/${encodeURIComponent(folderId)}/messages/delta`,
    `/v1.0/users/${encodeURIComponent(accountId)}/mailFolders/${encodeURIComponent(folderId)}/messages/delta`,
  ];
  if (
    url.origin !== "https://graph.microsoft.com" ||
    url.username ||
    url.password ||
    url.hash ||
    !paths.includes(url.pathname) ||
    !url.search ||
    ![...url.searchParams.keys()].every((k) =>
      [
        "$deltatoken",
        "$skiptoken",
        "$select",
        "$filter",
        "$top",
        "$orderby",
        "changeType",
      ].includes(k),
    ) ||
    (!url.searchParams.has("$deltatoken") &&
      !url.searchParams.has("$skiptoken"))
  )
    throw new MailboxError("mailbox_cursor_invalid");
  return url.toString();
}
const address = (value: unknown) =>
  String(object(object(value).emailAddress).address ?? "")
    .trim()
    .toLowerCase();
const stamp = (value: unknown) =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
const rfcId = (value: unknown) =>
  typeof value === "string" &&
  value.length <= 998 &&
  /^<[^<>\s]+@[^<>\s]+>$/.test(value)
    ? value
    : null;
function references(value: string) {
  const ids = value.match(/<[^<>\s]+>/g) ?? [];
  if (
    ids.length > 25 ||
    ids.some((id) => !rfcId(id)) ||
    value.replace(/<[^<>\s]+>/g, "").trim()
  )
    throw new MailboxError("mailbox_header_invalid");
  return ids;
}
export function normalizeMailboxMessage(
  raw: unknown,
  metadataOnly = false,
): MailboxMessage | null {
  const m = object(raw);
  if (m["@removed"] || m.isDraft === true) return null;
  if (
    !identifier(m.id) ||
    !Array.isArray(m.toRecipients) ||
    m.toRecipients.length < 1 ||
    m.toRecipients.length > 25 ||
    !Array.isArray(m.internetMessageHeaders) ||
    m.internetMessageHeaders.length > 150
  )
    throw new MailboxError("mailbox_message_invalid");
  const from = address(m.from),
    to = m.toRecipients.map(address).sort();
  const sentAt = stamp(m.sentDateTime),
    receivedAt = stamp(m.receivedDateTime),
    body = metadataOnly ? { contentType: "text", content: "" } : object(m.body);
  if (
    !isSafeMailbox(from) ||
    to.some((v) => !isSafeMailbox(v)) ||
    !sentAt ||
    !receivedAt ||
    typeof m.subject !== "string" ||
    m.subject.length > 1000 ||
    String(body.contentType).toLowerCase() !== "text" ||
    typeof body.content !== "string" ||
    Buffer.byteLength(body.content, "utf8") > MAILBOX_MAX_BODY
  )
    throw new MailboxError("mailbox_message_invalid");
  if (
    Date.parse(sentAt) > Date.now() + 60_000 ||
    Date.parse(receivedAt) > Date.now() + 60_000 ||
    (m.internetMessageId != null && !rfcId(m.internetMessageId))
  )
    throw new MailboxError("mailbox_message_invalid");
  const headers = new Map<string, string[]>();
  for (const rawHeader of m.internetMessageHeaders) {
    const h = object(rawHeader);
    if (
      typeof h.name !== "string" ||
      h.name.length > 100 ||
      typeof h.value !== "string" ||
      h.value.length > 8000
    )
      throw new MailboxError("mailbox_header_invalid");
    const key = h.name.toLowerCase();
    headers.set(key, [...(headers.get(key) ?? []), h.value]);
  }
  const parent = headers.get(MAILBOX_HEADER) ?? [];
  if (
    parent.length > 1 ||
    parent.some((v) => !/^[a-f0-9]{64}$/.test(v))
  )
    throw new MailboxError("mailbox_parent_header_invalid");
  return {
    providerMessageId: m.id,
    internetMessageId: rfcId(m.internetMessageId),
    from,
    to: [...new Set(to)],
    subject: m.subject,
    text: body.content,
    sentAt,
    receivedAt,
    correlationHeader: parent[0] ?? null,
    inReplyTo: references((headers.get("in-reply-to") ?? []).join(" ")),
    references: references((headers.get("references") ?? []).join(" ")),
    automated:
      (headers.get("auto-submitted") ?? []).some(
        (v) => v.trim().toLowerCase() !== "no",
      ) ||
      (headers.get("precedence") ?? []).some((v) => /bulk|list|junk/i.test(v)),
  };
}
export async function readMailboxDelta(
  input: {
    token: string;
    accountId: string;
    cursor: FolderCursor;
    startedAt: string;
  },
  transport: typeof fetch = fetch,
) {
  if (!identifier(input.cursor.folderId) || !stamp(input.startedAt))
    throw new MailboxError("mailbox_cursor_invalid");
  const initial = new URL(
    `${GRAPH}/me/mailFolders/${encodeURIComponent(input.cursor.folderId)}/messages/delta`,
  );
  initial.search = new URLSearchParams({
    $select: fields,
    $filter: `receivedDateTime ge ${new Date(input.startedAt).toISOString()}`,
    $top: String(MAILBOX_PAGE_SIZE),
    $orderby: "receivedDateTime desc",
  }).toString();
  const result = await get(
    input.cursor.continuation
      ? validateMailboxContinuation(
          input.cursor.continuation,
          input.cursor.folderId,
          input.accountId,
        )
      : initial.toString(),
    input.token,
    transport,
  );
  if (!Array.isArray(result.value) || result.value.length > MAILBOX_PAGE_SIZE)
    throw new MailboxError("mailbox_page_invalid");
  const next = result["@odata.nextLink"],
    delta = result["@odata.deltaLink"];
  if ((typeof next === "string") === (typeof delta === "string"))
    throw new MailboxError("mailbox_cursor_gap");
  const continuation = validateMailboxContinuation(
    String(next ?? delta),
    input.cursor.folderId,
    input.accountId,
  );
  // Filtered delta can still include old read-state changes and removals. Never
  // ingest them as post-opt-in mail, even when the provider returned them.
  const messages: MailboxMessage[] = [],
    rejected: MailboxRejectedMessage[] = [];
  for (const raw of result.value) {
    const m = object(raw);
    if (
      m["@removed"] ||
      m.isDraft === true ||
      (stamp(m.receivedDateTime) &&
        Date.parse(String(m.receivedDateTime)) < Date.parse(input.startedAt))
    )
      continue;
    // A known immutable ID with unsupported content is a bounded review item,
    // not a broken cursor. No body (even a provider-ignored projection) survives.
    if (!identifier(m.id)) throw new MailboxError("mailbox_page_invalid");
    try {
      const message = normalizeMailboxMessage(m, true);
      if (message) messages.push(message);
    } catch (error) {
      if (!(error instanceof MailboxError)) throw error;
      const { body: _body, ...metadata } = m;
      rejected.push({
        providerMessageId: m.id,
        contentSha256: mailboxDigest(metadata),
        reason: error.code,
      });
    }
  }
  return {
    messages,
    rejected,
    cursor: {
      ...input.cursor,
      continuation,
      complete: typeof delta === "string",
    },
  };
}
/** Re-read only an immutable ID already observed in this fixed Inbox. */
export async function readMailboxPendingMessage(
  token: string,
  inboxFolderId: string,
  messageId: string,
  transport: typeof fetch = fetch,
) {
  if (!identifier(inboxFolderId) || !identifier(messageId))
    throw new MailboxError("mailbox_message_invalid");
  return normalizeMailboxMessage(
    await get(
      `${GRAPH}/me/mailFolders/${encodeURIComponent(inboxFolderId)}/messages/${encodeURIComponent(messageId)}?$select=${fields},body`,
      token,
      async (url, init) => {
        const response = await transport(url, init);
        if (response.status === 404) {
          await response.body?.cancel();
          throw new MailboxError("mailbox_message_missing");
        }
        return response;
      },
    ),
  );
}
