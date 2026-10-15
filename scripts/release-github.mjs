#!/usr/bin/env node
/**
 * Tags the current commit with the published version and creates a GitHub release.
 *
 *   node scripts/release-github.mjs --check   # pre-publish checks only
 *   node scripts/release-github.mjs           # checks + tag + push + GitHub release
 *
 * Runs as part of `npm run deploy`: checks before `npm publish`, release after it.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const checkOnly = process.argv.includes('--check');

const sh = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const run = (cmd) => execSync(cmd, { stdio: 'inherit' });
const fail = (msg) => {
  console.error(`\n✖ release: ${msg}\n`);
  process.exit(1);
};

const readVersion = (path) => JSON.parse(readFileSync(path, 'utf8')).version;

const rootVersion = readVersion('package.json');
const libVersion = readVersion('libs/nestjs-profiler/package.json');
if (rootVersion !== libVersion) {
  fail(`version mismatch: package.json=${rootVersion}, libs/nestjs-profiler/package.json=${libVersion}. Bump both.`);
}

const tag = `v${libVersion}`;

try {
  sh('gh auth status');
} catch {
  fail('GitHub CLI not logged in. Run `gh auth login`.');
}

if (sh('git status --porcelain --untracked-files=no')) {
  fail('uncommitted changes to tracked files. Commit them so the tag matches what gets published.');
}

if (sh(`git tag --list ${tag}`) || sh(`git ls-remote --tags origin refs/tags/${tag}`)) {
  fail(`tag ${tag} already exists. Bump the version first.`);
}

if (checkOnly) {
  console.log(`✔ release: ready to publish ${tag}`);
  process.exit(0);
}

run(`git tag -a ${tag} -m "${tag}"`);
run(`git push origin refs/tags/${tag}`);
run(`gh release create ${tag} --title "${tag}" --generate-notes --latest --verify-tag`);
console.log(`✔ release: ${tag} tagged and published on GitHub`);
