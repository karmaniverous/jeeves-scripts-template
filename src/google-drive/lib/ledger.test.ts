import { describe, expect, it } from 'vitest';

import { fakeRunner } from './fake-runner.test-helper.js';
import { createLedgerStore, emptyRecord, NAMESPACE } from './ledger.js';
import { lastRunAt } from './orchestrate.js';

const ACCOUNT = 'assistant@example.com';

describe('ledger store (§6.1)', () => {
  it('round-trips records and skips unreadable ones', () => {
    const r = fakeRunner();
    const live = createLedgerStore(r.client, ACCOUNT, true);
    live.put('a', { ...emptyRecord(), localPath: 'x.md' });
    r.client.setItem(NAMESPACE, `files:${ACCOUNT}`, 'bad', '{"nope":1}');
    r.client.setItem(NAMESPACE, `files:${ACCOUNT}`, 'torn', '{"localPath":');
    const loaded = live.load();
    expect([...loaded.keys()]).toEqual(['a']);
    expect(loaded.get('a')?.localPath).toBe('x.md');
  });

  it('drops every write in a dry run', () => {
    const r = fakeRunner();
    const dry = createLedgerStore(r.client, ACCOUNT, false);
    dry.put('a', emptyRecord());
    dry.saveRunState({ lastRunAt: 'x' });
    expect(r.items.size).toBe(0);
    expect(r.state.size).toBe(0);
    expect(dry.reset()).toBe(0);
  });

  it('reset deletes items before the parent row (no cascade)', () => {
    const r = fakeRunner();
    const live = createLedgerStore(r.client, ACCOUNT, true);
    live.put('a', emptyRecord());
    live.put('b', emptyRecord());
    live.saveRunState({ lastRunAt: '2026-10-05' });
    expect(createLedgerStore(r.client, ACCOUNT, false).reset()).toBe(2); // dry: counts only
    expect(live.reset()).toBe(2);
    expect(live.load().size).toBe(0);
    expect(lastRunAt(live.loadRunState())).toBe('');
  });

  it('removes single records', () => {
    const r = fakeRunner();
    const live = createLedgerStore(r.client, ACCOUNT, true);
    live.put('a', emptyRecord());
    live.remove('a');
    expect(live.load().size).toBe(0);
  });
});
