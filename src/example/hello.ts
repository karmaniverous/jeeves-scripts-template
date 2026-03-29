/**
 * Example runner script — demonstrates the standard pattern.
 * Delete this file when you start building real scripts.
 */

import { runScript } from '../lib/run-script.js';
import { getRunnerClient } from '../lib/runner-client.js';

// Every script is wrapped in runScript() for crash handling.
runScript('hello', () => {
  const client = getRunnerClient();

  // Read a state value (returns undefined if not set).
  const lastRun = client.getState('example', 'lastRun');
  console.log(`Last run: ${lastRun ?? 'never'}`);

  // Write a state value.
  client.setState('example', 'lastRun', new Date().toISOString());
  console.log('Hello from jeeves-runner-scripts!');

  client.close();
});
