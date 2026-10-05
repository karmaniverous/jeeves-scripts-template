/**
 * @module google-drive/lib/meta-seed
 *
 * Seed `.meta/` at share roots and share points (spec §7.3) through the
 * meta service's `POST /seed` (the endpoint the `meta_seed` tool uses):
 * 201 = created, 409 = already exists (treated as success).
 */

import { META_PORT } from '@karmaniverous/jeeves';

export type SeedResult = 'created' | 'exists';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Seed one path. Throws on any status other than 201/409. */
export async function seedMeta(
  absPath: string,
  steer: string | null,
  fetchFn: FetchLike = fetch,
  baseUrl = `http://127.0.0.1:${String(META_PORT)}`,
): Promise<SeedResult> {
  const body: Record<string, string> = { path: absPath };
  if (steer) body.steer = steer;
  const res = await fetchFn(`${baseUrl}/seed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 201) return 'created';
  if (res.status === 409) return 'exists';
  throw new Error(
    `meta seed ${absPath}: HTTP ${String(res.status)} ${await res.text()}`,
  );
}

/** Default steer prompts (spec §7.3); config overrides win. */
export function defaultSteer(
  kind: 'root' | 'sharePoint',
  label: string,
): string {
  return kind === 'root'
    ? `Google Drive content shared to the assistant from ${label}. Synthesize what this material is about, who it involves, and how it is organised.`
    : `A shared Google Drive location (${label}). Synthesize its contents: purpose, key documents, decisions, and open questions.`;
}
