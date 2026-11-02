// vitest globalSetup (vite.config.ts): builds the allowed native dependencies (better-sqlite3) before any test loads
// them, so `npx vitest` right after `npm ci` works too. A no-op once built for this lockfile and Node version; see
// scripts/install-scripts.mjs.
import { ensure } from './install-scripts.mjs';

export default function setup() {
  ensure();
}
