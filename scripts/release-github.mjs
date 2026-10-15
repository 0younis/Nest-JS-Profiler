#!/usr/bin/env node
/**
 * Tags the current commit with the published version and creates a GitHub release.
 *
 *   node scripts/release-github.mjs --check   # pre-publish checks only
 *   node scripts/release-github.mjs           # post-publish: tag + push + GitHub release
 *
 * Runs as part of `npm run deploy`: checks before `npm publish`, release after it.
 * The release step is resumable: a tag or release that already exists for this
 * commit is reused, so `npm run release:github` can be re-run after a failure.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const checkOnly = process.argv.includes('--check');

const sh = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const run = (cmd) => execSync(cmd, { stdio: 'inherit' });
const tryCmd = (cmd) => {
  try {
    return sh(cmd);
  } catch {
    return null;
  }
};
const fail = (msg) => {
  console.error(`\n✖ release: ${msg}\n`);
  process.exit(1);
};

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

const root = readJson('package.json');
const lib = readJson('libs/nestjs-profiler/package.json');
if (root.version !== lib.version) {
  fail(`version mismatch: package.json=${root.version}, libs/nestjs-profiler/package.json=${lib.version}. Bump both.`);
}

const pkgName = lib.name;
const version = lib.version;
const tag = `v${version}`;

// The repo has more than one remote, so always tell gh which one to use.
const originUrl = tryCmd('git remote get-url origin');
const repoMatch = originUrl && originUrl.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
if (!repoMatch) fail(`could not read a GitHub repo from the origin remote (${originUrl || 'none'}).`);
const repo = repoMatch[1];

if (tryCmd('gh auth status') === null) {
  fail('GitHub CLI not logged in. Run `gh auth login`.');
}

if (sh('git status --porcelain --untracked-files=no')) {
  fail('uncommitted changes to tracked files. Commit them so the tag matches what gets published.');
}

const head = sh('git rev-parse HEAD');
const localTagCommit = tryCmd(`git rev-parse --verify --quiet "refs/tags/${tag}^{commit}"`);
const remoteTagLines = tryCmd(`git ls-remote --tags origin "refs/tags/${tag}" "refs/tags/${tag}^{}"`) || '';
// Annotated tags list the tag object first and the commit as ^{}; lightweight tags list only the commit.
const remoteTagCommit =
  (remoteTagLines.split('\n').find((l) => l.endsWith('^{}')) || remoteTagLines.split('\n')[0] || '').split(/\s+/)[0] ||
  null;

for (const [where, commit] of [
  ['locally', localTagCommit],
  ['on origin', remoteTagCommit],
]) {
  if (commit && commit !== head) {
    fail(`tag ${tag} already exists ${where} on another commit (${commit.slice(0, 7)}). Bump the version first.`);
  }
}

const isPublishedOnNpm = () => tryCmd(`npm view ${pkgName}@${version} version --prefer-online`) === version;

if (checkOnly) {
  if (isPublishedOnNpm()) fail(`${pkgName}@${version} is already published on npm. Bump the version first.`);
  console.log(`✔ release: ready to publish ${tag}`);
  process.exit(0);
}

// Post-publish: never tag or release a version that isn't on npm. Allow a short
// wait because the registry can take a few seconds to show a new version.
let published = isPublishedOnNpm();
for (let i = 0; !published && i < 6; i++) {
  console.log(`… waiting for ${pkgName}@${version} to appear on npm`);
  execSync('sleep 5');
  published = isPublishedOnNpm();
}
if (!published) {
  fail(`${pkgName}@${version} is not on npm. Publish it first (npm run deploy), then re-run npm run release:github.`);
}

if (!localTagCommit) run(`git tag -a ${tag} -m "${tag}"`);
if (!remoteTagCommit) run(`git push origin "refs/tags/${tag}"`);

if (tryCmd(`gh release view ${tag} --repo ${repo}`) !== null) {
  console.log(`✔ release: GitHub release ${tag} already exists, nothing to do`);
} else {
  run(`gh release create ${tag} --repo ${repo} --title "${tag}" --generate-notes --latest --verify-tag`);
  console.log(`✔ release: ${tag} tagged and published on GitHub`);
}
