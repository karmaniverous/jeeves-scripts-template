/**
 * @module imap-secrets
 *
 * Resolves IMAP passwords. In pipeline-config.json an account's
 * `imap.password` is either `{ "secretRef": "<name>" }` (preferred) or a
 * literal string (deprecated). A secretRef names a file in
 * `IMAP_SECRETS_DIR` (`<CREDENTIALS_DIR>/imap/<name>`), which the IMAP
 * poller reads when it connects. jeeves-tools provisions those files from
 * the instance config's `secrets` map; standalone instances write them by
 * hand (owner jeeves, mode 0600).
 *
 * Password values are never logged or included in error messages.
 *
 * Called by lib/pipeline-config.ts (secretRef validation) and
 * email/imap/poll.ts (resolution at connect time).
 *
 * Config dependencies: IMAP_SECRETS_DIR from constants.ts.
 */

import fs from 'node:fs';
import path from 'node:path';

import { IMAP_SECRETS_DIR } from './constants.js';

/** `imap.password` in pipeline config: a secret reference or a literal. */
export type ImapPassword = string | { secretRef: string };

/**
 * The jeeves-tools secret-name rule (instance config `secrets` map): 1-64
 * characters, letters, digits, `_` and `-`, starting with a letter or digit.
 * Kept identical so every secretRef the template accepts can be provisioned
 * by jeeves-tools (`config set <instance> secrets.<name> --stdin`); no dots,
 * so never `.`, `..` or a path separator.
 */
const SECRET_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * True when `ref` is a valid secret name (see {@link SECRET_REF_PATTERN}),
 * and so a safe file name inside the secrets directory.
 */
export function isSafeSecretRef(ref: string): boolean {
  return SECRET_REF_PATTERN.test(ref);
}

/** Message used when a secretRef is not a valid secret name. */
export const UNSAFE_SECRET_REF_MESSAGE =
  'secretRef must be a plain file name of 1-64 characters: letters, digits, "_" and "-", starting with a letter or digit (no "/", "\\", "." or "..")';

/**
 * Path of the file holding the secret named `ref`.
 *
 * @throws When `ref` is not a safe file name.
 */
export function imapSecretPath(ref: string, dir = IMAP_SECRETS_DIR): string {
  if (!isSafeSecretRef(ref))
    throw new Error(`IMAP secretRef "${ref}": ${UNSAFE_SECRET_REF_MESSAGE}`);
  return path.join(dir, ref);
}

/**
 * Resolve an `imap.password` value to the password itself. A literal
 * string is returned as is; a secretRef is read from its file with
 * trailing newlines removed.
 *
 * @throws When the file is missing, unreadable or empty. The message
 *   names the ref and the path, never the value.
 */
export function resolveImapPassword(
  password: ImapPassword,
  dir = IMAP_SECRETS_DIR,
): string {
  if (typeof password === 'string') return password;
  const { secretRef } = password;
  const file = imapSecretPath(secretRef, dir);
  let value: string;
  try {
    value = fs.readFileSync(file, 'utf8');
  } catch (e) {
    const code =
      e instanceof Error && 'code' in e ? String(e.code) : 'read failed';
    throw new Error(
      `IMAP secret "${secretRef}" could not be read from ${file} (${code}).`,
      { cause: e },
    );
  }
  const trimmed = value.replace(/(?:\r?\n)+$/, '');
  if (!trimmed)
    throw new Error(`IMAP secret "${secretRef}" at ${file} is empty.`);
  return trimmed;
}
