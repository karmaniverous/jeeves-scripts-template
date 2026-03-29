# Project Requirements (jeeves-runner-scripts-template)

When updated: 2026-03-29T11:15:00Z

## Overview

Template repository for TypeScript runner scripts targeting jeeves-runner.
Provides shared infrastructure (crash handler, runner client, shell utils,
filesystem helpers) and quality tooling (ESLint, Prettier, Vitest, knip, STAN).

Scripts are executed directly via tsx — this is NOT a library build.

## Structure

- `src/lib/` — shared infrastructure, generic and reusable
- `src/{domain}/` — scripts organized by domain
- `src/example/` — sample script demonstrating the pattern

## Quality Gates

- typecheck: `tsc --noEmit`
- lint: ESLint with strict TypeScript rules + Prettier
- test: Vitest
- knip: unused export/dependency detection
- STAN: orchestrates all of the above sequentially
