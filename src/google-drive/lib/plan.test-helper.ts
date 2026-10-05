/**
 * @module google-drive/lib/plan.test-helper
 *
 * Shared builders for the planner tests.
 */

import { emptyRecord, type LedgerRecord } from './ledger.js';
import type { PlanInput, PlanItem } from './plan.js';

export const NOW = new Date('2026-10-05T12:00:00Z');
export const deletion = { maxFraction: 0.2, minCount: 25 };

export function item(
  id: string,
  desiredPath: string,
  over: Partial<PlanItem> = {},
): PlanItem {
  return {
    id,
    modifiedTime: '2026-10-05T00:00:00Z',
    kind: 'text',
    desiredPath,
    preSkip: null,
    probeKey: `md5:${id}`,
    pathResolved: true,
    shareIds: ['s'],
    ...over,
  };
}

export function written(
  localPath: string,
  key: string,
  over: Partial<LedgerRecord> = {},
): LedgerRecord {
  return {
    ...emptyRecord(),
    localPath,
    written: {
      contentKey: key,
      modifiedTime: '2026-10-05T00:00:00Z',
      kind: 'text',
      at: 'x',
    },
    ...over,
  };
}

export function input(over: Partial<PlanInput>): PlanInput {
  return {
    items: [],
    ledger: new Map(),
    diskFiles: [],
    diskMetaDirs: [],
    shareDirs: [],
    enumerationErrors: 0,
    now: NOW,
    deletion,
    allowMassDelete: false,
    ...over,
  };
}
