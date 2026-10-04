/**
 * @module message-record
 *
 * Builds the per-message JSON record download.ts writes, and the short
 * summary it keeps in `thread.json`, from a Gmail API message object
 * (`gog gmail get` / `gog gmail thread`). One builder for both download
 * paths (full-thread fetch and per-message fetch).
 *
 * Called by email/google-workspace/download.ts.
 */

import {
  extractAttachments,
  extractTextFromPayload,
  type GmailHeader,
  type GmailPayloadPart,
  headerValue,
} from '../../lib/email.js';

type MessagePayload = GmailPayloadPart & { headers?: GmailHeader[] };

function payloadOf(
  message: Record<string, unknown>,
): MessagePayload | undefined {
  return message.payload as MessagePayload | undefined;
}

/** Message summary stored in `thread.json` `messages`. */
export interface MessageSummary {
  id: string;
  snippet: string;
  date: string;
}

/** Summary of `message` for the thread's `messages` map. */
export function messageSummary(
  messageId: string,
  message: Record<string, unknown>,
): MessageSummary {
  return {
    id: messageId,
    snippet: (message.snippet as string | undefined) ?? '',
    date: headerValue(payloadOf(message)?.headers, 'Date'),
  };
}

/** A message record ready to write, plus its attachment count. */
export interface MessageRecord {
  record: Record<string, unknown>;
  attachmentCount: number;
}

/** Build the on-disk record for one downloaded message. */
export function messageRecord(
  ids: { account: string; threadId: string; messageId: string },
  message: Record<string, unknown>,
  downloadedAt: string,
): MessageRecord {
  const payload = payloadOf(message);
  const hdrs = payload?.headers ?? [];
  const body = extractTextFromPayload(payload);
  const atts = extractAttachments(payload);
  return {
    record: {
      messageId: ids.messageId,
      threadId: ids.threadId,
      account: ids.account,
      subject: headerValue(hdrs, 'Subject'),
      from: headerValue(hdrs, 'From'),
      to: headerValue(hdrs, 'To'),
      cc: headerValue(hdrs, 'Cc'),
      date: headerValue(hdrs, 'Date'),
      internalDateMs: message.internalDate
        ? Number(message.internalDate)
        : null,
      labels: message.labelIds ?? [],
      body: { text: body.text, html: body.html },
      attachments: atts.map((a) => ({
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.size,
      })),
      downloadedAt,
    },
    attachmentCount: atts.length,
  };
}
