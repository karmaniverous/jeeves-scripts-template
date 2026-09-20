#!/usr/bin/env tsx
/**
 * @module qdrant-health-check
 *
 * Monitors Qdrant vector database health by checking collection status
 * and optimizer state via the HTTP API. When a collection enters "red"
 * status or the optimizer reports an error (e.g. stuck file locks
 * preventing segment compaction), restarts the Qdrant system service
 * to clear the condition.
 *
 * Exits 0 on healthy or successful restart. Exits non-zero only when
 * the restart itself fails.
 *
 * Config dependencies: QDRANT_API_URL, QDRANT_SERVICE_NAME from constants.ts.
 */

import { execSync } from 'node:child_process';
import http from 'node:http';

import { runScript } from '@karmaniverous/jeeves';

import { QDRANT_API_URL, QDRANT_SERVICE_NAME } from '../lib/constants.js';

/** Shape of a single collection's detail response. */
interface CollectionDetail {
  status: string;
  optimizer_status: 'ok' | { error: string };
  segments_count: number;
  points_count: number;
}

/** Standard Qdrant API envelope. */
interface QdrantResponse<T> {
  result: T;
  status: string;
}

/** Collections list payload. */
interface CollectionsList {
  collections: { name: string }[];
}

/**
 * Perform a GET request and parse the JSON response.
 */
function httpGet<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = '';
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data) as T);
          } catch {
            reject(new Error(`Failed to parse response from ${url}: ${data}`));
          }
        });
      })
      .on('error', reject);
  });
}

/**
 * Restart the Qdrant system service using the platform-appropriate command.
 */
function restartService(): void {
  const serviceName = QDRANT_SERVICE_NAME;

  if (process.platform === 'win32') {
    execSync(
      `powershell -Command "Restart-Service -Name '${serviceName}' -Force"`,
      { timeout: 30_000 },
    );
  } else {
    execSync(`systemctl restart ${serviceName}`, { timeout: 30_000 });
  }
}

async function main() {
  const collectionsResp = await httpGet<QdrantResponse<CollectionsList>>(
    `${QDRANT_API_URL}/collections`,
  );

  const collections = collectionsResp.result.collections;

  if (collections.length === 0) {
    console.log('No collections found.');
    return;
  }

  let needsRestart = false;
  const issues: string[] = [];

  for (const { name } of collections) {
    const detail = await httpGet<QdrantResponse<CollectionDetail>>(
      `${QDRANT_API_URL}/collections/${encodeURIComponent(name)}`,
    );

    const { status, optimizer_status, segments_count, points_count } =
      detail.result;

    const optimizerError =
      typeof optimizer_status !== 'string' ? optimizer_status.error : null;

    if (status === 'red' || optimizerError) {
      needsRestart = true;
      const reason = optimizerError
        ? `optimizer error: ${optimizerError}`
        : `status: ${status}`;
      issues.push(
        `Collection "${name}" unhealthy — ${reason} (${String(points_count)} points, ${String(segments_count)} segments)`,
      );
    } else {
      console.log(
        `Collection "${name}": ${status}, ${String(points_count)} points, ${String(segments_count)} segments — healthy`,
      );
    }
  }

  if (!needsRestart) {
    console.log('All collections healthy.');
    return;
  }

  for (const issue of issues) {
    console.log(`⚠ ${issue}`);
  }

  console.log(`Restarting ${QDRANT_SERVICE_NAME} service...`);

  try {
    restartService();
    console.log(`✓ ${QDRANT_SERVICE_NAME} restarted successfully.`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`✗ Failed to restart ${QDRANT_SERVICE_NAME}: ${msg}`);
    process.exitCode = 1;
  }
}

runScript('core/qdrant-health-check', main);
