/**
 * @module email-triage
 *
 * Pure-function helpers for classifying email threads as receipts, junk,
 * or org-specific buckets, and deciding which labels to apply.
 *
 * Called by poll.ts, email-fetch.ts, and all backfill scripts during
 * thread processing. Classification drives label actions enqueued to
 * `email-updates` and controls which threads get deep-fetched.
 *
 * Bucket classification depends on pipeline-config domain mappings and
 * priority order. Missing config causes classifyBucket to return null.
 */

import {
  getBucketForDomain,
  getBucketNames,
  getBucketPriority,
  loadPipelineConfig,
} from '../../lib/pipeline-config.js';

/** Test whether subject/snippet/from suggest a financial receipt or invoice. */
export function isReceiptCandidate(
  subject: string,
  snippet: string,
  from: string,
  account?: string,
): boolean {
  // Emails FROM the polled account are never receipts
  if (account && from.toLowerCase().includes(account.toLowerCase()))
    return false;

  const s = `${subject} ${snippet} ${from}`.toLowerCase();
  return /(invoice|receipt|order|paid|payment|statement|tax|bill|amount due|subscription)/.test(
    s,
  );
}

/** Test whether subject/snippet/from suggest a newsletter or promo. */
export function isJunkCandidate(
  subject: string,
  snippet: string,
  from: string,
): boolean {
  const s = `${subject} ${snippet} ${from}`.toLowerCase();
  return /(newsletter|unsubscribe|promo|promotion|deal|sale|limited time|webinar|marketing)/.test(
    s,
  );
}

/** Extract unique domains from a raw TO header string. */
function extractDomains(to: string): string[] {
  const seen = new Set<string>();
  const re = /[\w.+-]+@([\w.-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(to)) !== null) {
    seen.add(m[1].toLowerCase());
  }
  return Array.from(seen);
}

/**
 * Assign a configured bucket (`buckets` in pipeline-config) based on
 * account domain, TO-domain priority, or content matching. Returns null
 * if no bucket matches.
 */
export function classifyBucket(
  account: string,
  to: string,
  subject: string,
  snippet: string,
  from: string,
): string | null {
  // 1. Account-level override
  const domainBuckets = loadPipelineConfig().buckets.domains;
  const accountDomain = account.split('@')[1]?.toLowerCase();
  if (accountDomain) {
    const match = domainBuckets.find(
      (d) => d.pattern.toLowerCase() === accountDomain,
    );
    if (match) return match.bucket;
  }

  // 2. TO-domain model
  const domains = extractDomains(to);
  const priority = getBucketPriority();
  let best: string | null = null;
  let bestPri = Infinity;
  for (const d of domains) {
    const bucket = getBucketForDomain(d);
    if (bucket && (priority[bucket] ?? Infinity) < bestPri) {
      best = bucket;
      bestPri = priority[bucket] ?? Infinity;
    }
  }
  if (best) return best;

  // 3. Fallback: content matching
  const s = `${subject} ${snippet} ${from}`;
  for (const entry of domainBuckets) {
    if (new RegExp(entry.pattern.replaceAll('.', '\\.'), 'i').test(s))
      return entry.bucket;
  }
  return null;
}

/** Quick heuristic: should this thread get a deep metadata fetch? */
export function looksImportantBySummary(params: {
  labels: string[];
  receiptCandidate: boolean;
  bucket: string | null;
}): boolean {
  const set = new Set(params.labels);
  if (set.has('INBOX') || set.has('UNREAD')) return true;
  if (params.receiptCandidate) return true;
  if (params.bucket) {
    const priority = getBucketPriority();
    if (params.bucket in priority) return true;
  }
  return false;
}

/** Decide whether an outgoing thread should be tracked for a reply. */
export function shouldExpectResponse(params: {
  subject: string;
  from: string;
  to: string;
  receiptCandidate: boolean;
  junkCandidate: boolean;
}): boolean {
  const f = (params.from || '').toLowerCase();
  const t = (params.to || '').toLowerCase();

  if (
    /(no-reply|noreply|do-not-reply|donotreply)/.test(f) ||
    /(no-reply|noreply|do-not-reply|donotreply)/.test(t)
  )
    return false;
  if (params.receiptCandidate || params.junkCandidate) return false;
  if (
    f.includes('voice-noreply@google.com') ||
    (params.subject || '').toLowerCase().includes('new voicemail')
  )
    return false;
  return true;
}

/** Return classification labels not yet applied (receipt, junk, bucket). */
export function computeLabelsToApply(params: {
  receiptCandidate: boolean;
  junkCandidate: boolean;
  bucket: string | null;
  labelApplied?: Record<string, string>;
}): string[] {
  const applied = params.labelApplied ?? {};
  const labels: string[] = [];
  if (params.receiptCandidate && !applied['receipt']) labels.push('receipt');
  if (params.junkCandidate && !applied['junk']) labels.push('junk');
  if (params.bucket && !applied[params.bucket]) labels.push(params.bucket);
  return labels;
}

/**
 * `bucket` if it is a currently configured bucket, else null (e.g. a
 * bucket stored in thread state under an older config).
 */
export function configuredBucket(
  bucket: string | null | undefined,
): string | null {
  return bucket && getBucketNames().includes(bucket) ? bucket : null;
}

/**
 * Zeroed per-label counters for the classification labels: `receipt`,
 * `junk`, then each configured bucket.
 */
export function newLabelCounts(): Record<string, number> {
  return Object.fromEntries(
    ['receipt', 'junk', ...getBucketNames()].map((l) => [l, 0]),
  );
}

/** Build the store key for a pending follow-up entry. */
export function pendingKey(account: string, threadId: string): string {
  return `${account}::${threadId}`;
}
