#!/usr/bin/env node
// Install-script policy. `.npmrc` sets ignore-scripts=true, so npm runs no preinstall, install or postinstall script
// of any dependency. The few packages that need one are listed in package.json "allowedInstallScripts"; this script
// runs exactly those and keeps the list honest.
//
//   node scripts/install-scripts.mjs check    exit 1 when .npmrc does not set ignore-scripts=true, when a package in
//                                            package-lock.json has an install script and is not on the list, or when
//                                            a listed package has no install script any more (the list stays exact)
//   node scripts/install-scripts.mjs rebuild  run the install scripts of the listed packages that are installed
//                                            (`npm rebuild --ignore-scripts=false <names>`). npm installs fsevents
//                                            only on macOS, so it is rebuilt only there.
//   node scripts/install-scripts.mjs ensure   rebuild only when node_modules was not yet rebuilt for this lockfile,
//                                            Node ABI and platform (`npm run build`, `npm run dev` and the vitest
//                                            global setup call it, so `npm ci && npm run build` still gives a working
//                                            install)
//
// A package that is optional in the lockfile (fsevents) and fails to build is a warning, as it is for npm itself;
// every other failure, including a timeout, exits 1.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)); // the package root, wherever it is run from
const STAMP = join(ROOT, 'node_modules', '.install-scripts-stamp');
// Compiling a native module from source can take minutes; INSTALL_SCRIPTS_TIMEOUT_MS overrides it (tests)
const REBUILD_TIMEOUT_MS = Number(process.env.INSTALL_SCRIPTS_TIMEOUT_MS) || 15 * 60 * 1000;

class PolicyError extends Error {}

function fail(message) {
  throw new PolicyError(message);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
  } catch (err) {
    fail(`cannot read ${file}: ${err.message}`);
  }
}

function loadPolicy() {
  const pkg = readJson('package.json');
  const lock = readJson('package-lock.json');
  const allowed = pkg.allowedInstallScripts;
  if (!Array.isArray(allowed) || !allowed.every((name) => typeof name === 'string' && name.length > 0)) {
    fail('package.json "allowedInstallScripts" must be a list of package names');
  }
  if (!lock.packages || typeof lock.packages !== 'object') {
    fail('package-lock.json has no "packages" map (lockfileVersion 2 or later is required)');
  }
  return { allowed, lock };
}

/** Lockfile entries by package name: the paths it is installed at, and whether any of them has an install script */
function packagesByName(lock) {
  const byName = new Map();
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === '' || entry.link) continue;
    const at = path.lastIndexOf('node_modules/');
    const name = entry.name ?? path.slice(at + 'node_modules/'.length);
    const info = byName.get(name) ?? { paths: [], scripted: [], optional: true };
    info.paths.push(path);
    if (entry.hasInstallScript) info.scripted.push(path);
    if (!entry.optional) info.optional = false;
    byName.set(name, info);
  }
  return byName;
}

/** The last ignore-scripts assignment in .npmrc wins, as it does for npm */
function npmrcIgnoresScripts() {
  let text;
  try {
    text = readFileSync(join(ROOT, '.npmrc'), 'utf8');
  } catch {
    return false;
  }
  let value = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#') || line.startsWith(';')) continue;
    const m = /^ignore-scripts\s*=\s*(\S+)$/.exec(line);
    if (m) value = m[1].toLowerCase() === 'true';
  }
  return value;
}

function check() {
  const { allowed, lock } = loadPolicy();
  const byName = packagesByName(lock);
  const problems = [];
  if (!npmrcIgnoresScripts()) {
    problems.push('.npmrc must set ignore-scripts=true, or every dependency install script runs on npm install');
  }
  for (const [name, info] of byName) {
    if (info.scripted.length > 0 && !allowed.includes(name)) {
      problems.push(
        `${name} (${info.scripted.join(', ')}) has an install script and is not in package.json ` +
          '"allowedInstallScripts": read its script, then add it to the list (and to the install docs) or drop it',
      );
    }
  }
  for (const name of allowed) {
    if (!(byName.get(name)?.scripted.length > 0)) {
      problems.push(`${name} is in "allowedInstallScripts" but has no install script in package-lock.json: remove it`);
    }
  }
  if (problems.length > 0) fail(problems.join('\n'));
  console.log(`install-scripts: ok (${allowed.join(', ')} may run install scripts; all others are off)`);
}

/** Changes when the lockfile entries of the listed packages, the Node ABI or the platform change */
function stampFor(allowed, byName, lock) {
  const entries = allowed.flatMap((name) =>
    (byName.get(name)?.paths ?? []).map((path) => {
      const e = lock.packages[path];
      return `${path}@${e.version ?? ''}@${e.integrity ?? ''}`;
    }),
  );
  const key = { abi: process.versions.modules, platform: process.platform, arch: process.arch, entries: entries.sort() };
  return createHash('sha256').update(JSON.stringify(key)).digest('hex');
}

function npm(args) {
  // INSTALL_SCRIPTS_NPM: a JS file run with this Node in place of npm (tests)
  const fake = process.env.INSTALL_SCRIPTS_NPM;
  const [cmd, argv] = fake ? [process.execPath, [fake, ...args]] : ['npm', args];
  const r = spawnSync(cmd, argv, { cwd: ROOT, stdio: 'inherit', timeout: REBUILD_TIMEOUT_MS, killSignal: 'SIGKILL' });
  if (r.error) return `${r.error.code === 'ETIMEDOUT' ? 'timed out' : r.error.message}`;
  if (r.signal) return `stopped by ${r.signal}`;
  return r.status === 0 ? null : `exit code ${r.status}`;
}

function rebuild() {
  const { allowed, lock } = loadPolicy();
  if (!existsSync(join(ROOT, 'node_modules'))) fail('node_modules is missing: run npm ci (or npm install) first');
  const byName = packagesByName(lock);
  rmSync(STAMP, { force: true });
  const installed = allowed.filter((name) =>
    (byName.get(name)?.paths ?? []).some((path) => existsSync(join(ROOT, path, 'package.json'))),
  );
  const required = installed.filter((name) => !byName.get(name).optional);
  const optional = installed.filter((name) => byName.get(name).optional);
  if (required.length > 0) {
    console.log(`install-scripts: running the install scripts of ${required.join(', ')}`);
    const err = npm(['rebuild', '--ignore-scripts=false', ...required]);
    if (err) fail(`npm rebuild ${required.join(' ')} failed (${err})`);
  }
  for (const name of optional) {
    console.log(`install-scripts: running the install script of optional ${name}`);
    const err = npm(['rebuild', '--ignore-scripts=false', name]);
    if (err) console.warn(`install-scripts: warning: optional ${name} did not build (${err}); keeping it as installed`);
  }
  writeFileSync(STAMP, `${stampFor(allowed, byName, lock)}\n`);
}

/** Rebuilds when needed; throws on failure (the vitest global setup calls it too) */
export function ensure() {
  const { allowed, lock } = loadPolicy();
  const byName = packagesByName(lock);
  let current = '';
  try {
    current = readFileSync(STAMP, 'utf8').trim();
  } catch {
    // not rebuilt yet
  }
  if (current !== stampFor(allowed, byName, lock)) rebuild();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const commands = { check, rebuild, ensure };
  try {
    const run = commands[process.argv[2]];
    if (!run) fail('usage: node scripts/install-scripts.mjs check|rebuild|ensure');
    run();
  } catch (err) {
    if (!(err instanceof PolicyError)) throw err;
    for (const line of err.message.split('\n')) console.error(`install-scripts: ${line}`);
    process.exitCode = 1;
  }
}
