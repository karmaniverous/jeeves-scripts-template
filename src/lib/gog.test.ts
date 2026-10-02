import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@karmaniverous/jeeves', () => ({
  runWithRetry: vi.fn(),
}));

import { runWithRetry } from '@karmaniverous/jeeves';

import { GOG, gogWithRetry } from './gog.js';

describe('gog', () => {
  describe('GOG_HOME', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('defaults to the jeeves-tools gog home when unset', async () => {
      vi.stubEnv('GOG_HOME', undefined);
      vi.resetModules();
      await import('./gog.js');
      expect(process.env.GOG_HOME).toBe('/opt/jeeves/config/gogcli');
    });

    it('keeps a GOG_HOME already set by the service unit', async () => {
      vi.stubEnv('GOG_HOME', '/srv/gog');
      vi.resetModules();
      await import('./gog.js');
      expect(process.env.GOG_HOME).toBe('/srv/gog');
    });
  });

  describe('GOG constant', () => {
    it('is a non-empty string path', () => {
      expect(typeof GOG).toBe('string');
      expect(GOG.length).toBeGreaterThan(0);
    });
  });

  describe('gogWithRetry', () => {
    it('calls runWithRetry with correct binary and args', () => {
      vi.mocked(runWithRetry).mockReturnValue('success output');

      const result = gogWithRetry(['mail', 'list', '--account=test@x.com']);
      expect(result).toBe('success output');
      expect(runWithRetry).toHaveBeenCalledWith(
        GOG,
        ['mail', 'list', '--account=test@x.com'],
        expect.objectContaining({
          retries: 2,
          backoffMs: 5000,
        }),
      );
    });

    it('respects custom retries and backoffMs', () => {
      vi.mocked(runWithRetry).mockReturnValue('');

      gogWithRetry(['cal', 'list'], { retries: 5, backoffMs: 10_000 });
      expect(runWithRetry).toHaveBeenCalledWith(
        GOG,
        ['cal', 'list'],
        expect.objectContaining({
          retries: 5,
          backoffMs: 10_000,
        }),
      );
    });

    it('uses default retries=2 and backoffMs=5000 when not specified', () => {
      vi.mocked(runWithRetry).mockReturnValue('');

      gogWithRetry(['mail', 'get']);
      const callArgs = vi.mocked(runWithRetry).mock.calls[0][2]!;
      expect(callArgs.retries).toBe(2);
      expect(callArgs.backoffMs).toBe(5000);
    });

    it('provides isRetryable that matches timeout patterns', () => {
      vi.mocked(runWithRetry).mockReturnValue('');

      gogWithRetry(['test']);
      const callArgs = vi.mocked(runWithRetry).mock.calls[0][2]!;
      const isRetryable = callArgs.isRetryable as (e: unknown) => boolean;

      expect(isRetryable(new Error('context deadline exceeded'))).toBe(true);
      expect(isRetryable(new Error('request timed out'))).toBe(true);
      expect(isRetryable(new Error('connection timeout'))).toBe(true);
      expect(isRetryable(new Error('permission denied'))).toBe(false);
      expect(isRetryable(new Error('file not found'))).toBe(false);
    });

    it('propagates errors from runWithRetry', () => {
      vi.mocked(runWithRetry).mockImplementation(() => {
        throw new Error('all retries exhausted');
      });

      expect(() => gogWithRetry(['fail'])).toThrow('all retries exhausted');
    });
  });
});
