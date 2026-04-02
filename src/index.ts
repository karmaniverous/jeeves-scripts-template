/**
 * jeeves-scripts entry point.
 *
 * This repo is not a library — scripts are executed directly via tsx.
 * This file exists for TypeScript tooling and knip's entry resolution.
 *
 * Repo structure:
 *   src/lib/       — shared infrastructure (constants, runner client)
 *   src/{domain}/  — scripts organized by domain (e.g. src/github/, src/email/)
 *   src/example/   — sample script (delete when you start building)
 *
 * General utilities (fs-utils, shell, run-script, google-auth) are
 * imported from @karmaniverous/jeeves. Runner-specific utilities
 * (getRunnerClient, runDispatcher) from @karmaniverous/jeeves-runner.
 */

export {};
