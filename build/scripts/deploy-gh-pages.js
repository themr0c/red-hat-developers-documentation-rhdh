/**
 * deploy-gh-pages.js — Deploy documentation builds to GitHub Pages
 *
 * Copyright (c) Red Hat, Inc.
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 *
 * Replaces deploy-gh-pages.sh. Deploys content to the gh-pages branch
 * with retry on push rejection, PR/branch cleanup, and index regeneration.
 *
 * Usage:
 *   node deploy-gh-pages.js --publish-dir <dir> [--message <msg>]
 *
 * Environment: GITHUB_TOKEN, GITHUB_REPOSITORY (set by GitHub Actions)
 */

import { readdirSync, statSync, writeFileSync, existsSync, cpSync, rmSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { get as httpsGet } from 'node:https';

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const RELEASE_NOTES_BASE = 'https://red-hat-developers-documentation.pages.redhat.com/red-hat-developer-hub-release-notes';

// ── Helpers ──────────────────────────────────────────────────────────────────

function git(cwd, ...args) {
  const result = execFileSync('git', args, { // NOSONAR: git is resolved from PATH in a controlled CI environment
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 120_000,
    encoding: 'utf8',
  });
  return (result || '').trim();
}

function noStagedChanges(cwd) {
  try {
    git(cwd, 'diff', '--cached', '--quiet');
    return true;
  } catch {
    return false;
  }
}

function getPRState(owner, repo, prNumber) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${owner}/${repo}/pulls/${prNumber}`,
      headers: {
        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
        'User-Agent': 'deploy-gh-pages',
        'Accept': 'application/vnd.github+json',
      },
    };
    httpsGet(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          console.log(`GitHub API returned ${res.statusCode} for PR ${prNumber}`);
          resolve('unknown');
          return;
        }
        try {
          const json = JSON.parse(data);
          const closedState = json.merged ? 'merged' : 'closed';
          resolve(json.state === 'closed' ? closedState : 'open');
        } catch { resolve('unknown'); }
      });
      res.on('error', () => resolve('unknown'));
    }).on('error', () => resolve('unknown'));
  });
}

// ── gh-pages branch setup ────────────────────────────────────────────────────

function fetchOrCreateGhPages(deployDir) {
  try {
    git(deployDir, 'fetch', 'origin', 'gh-pages', '--depth=1');
    git(deployDir, 'checkout', '-B', 'gh-pages', 'FETCH_HEAD');
  } catch (err) {
    if (/not found|couldn't find|no such remote ref/i.test(err.message || err.stderr || '')) {
      console.log('gh-pages branch does not exist, creating orphan');
      git(deployDir, 'checkout', '--orphan', 'gh-pages');
      try { git(deployDir, 'rm', '-rf', '.'); } catch {}
    } else {
      throw err;
    }
  }
}

// ── Content application ──────────────────────────────────────────────────────

function applyContent(deployDir, publishDir, branchDir) {
  cpSync(publishDir, deployDir, { recursive: true });
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

async function cleanup(deployDir) {
  const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');

  // PR cleanup: remove directories for merged/closed PRs
  const prDirs = readdirSync(deployDir).filter(d =>
    d.startsWith('pr-') && !d.startsWith('.') && statSync(join(deployDir, d)).isDirectory()
  );

  for (const dir of prDirs) {
    const match = dir.match(/^pr-(\d+)$/);
    if (!match) continue;
    const prNumber = match[1];
    const state = await getPRState(owner, repo, prNumber);
    if (state === 'merged' || state === 'closed') {
      console.log(`Removing ${dir} (PR ${state})`);
      rmSync(join(deployDir, dir), { recursive: true, force: true });
    }
  }

  // Branch cleanup: remove directories for deleted remote branches
  const branchDirs = readdirSync(deployDir).filter(d =>
    !d.startsWith('pr-') && !d.startsWith('.') && statSync(join(deployDir, d)).isDirectory()
  );

  for (const dir of branchDirs) {
    try {
      const output = git(deployDir, 'ls-remote', '--heads', 'origin', dir);
      if (!output) {
        console.log(`Removing ${dir} (branch no longer exists on remote)`);
        rmSync(join(deployDir, dir), { recursive: true, force: true });
      }
    } catch {
      // If ls-remote fails, keep the directory to be safe
    }
  }
}

// ── Index generation ─────────────────────────────────────────────────────────

function getReleaseNotesUrl(branch) {
  if (branch === 'main') return `${RELEASE_NOTES_BASE}/main/index.html`;
  const match = branch.match(/^release-(\d+)\.(\d+)$/);
  if (match && (Number(match[1]) > 1 || Number(match[2]) >= 9))
    return `${RELEASE_NOTES_BASE}/release-${match[1]}-${match[2]}/index.html`;
  return null;
}

function writeIndex(deployDir, dirs, filename, title, isPR) {
  const entries = dirs.map(dir => {
    let entry = `<li><a href=./${dir}/index.html>${dir}</a>`;
    if (!isPR) {
      const rnUrl = getReleaseNotesUrl(dir);
      if (rnUrl) entry += ` | <a href="${rnUrl}">Release Notes</a>`;
    }
    return entry + '</li>';
  });

  const html = `<html><head><title>RHDH Documentation - ${title}</title></head>\n<body>\n<ul>\n${entries.join('\n')}\n</ul>\n</body></html>`;
  writeFileSync(join(deployDir, filename), html);
}

function regenerateIndex(deployDir, branchDir) {
  const allDirs = readdirSync(deployDir)
    .filter(d => !d.startsWith('.') && statSync(join(deployDir, d)).isDirectory())
    .sort();

  const isPR = branchDir.startsWith('pr-');

  // Branch deploys regenerate both indexes; PR deploys regenerate pulls.html only
  if (!isPR) {
    writeIndex(deployDir, allDirs.filter(d => !d.startsWith('pr-')), 'index.html', 'Documentation Branches', false);
  }
  writeIndex(deployDir, allDirs.filter(d => d.startsWith('pr-')), 'pulls.html', 'PR Previews', true);
}

// ── Push with retry ──────────────────────────────────────────────────────────

async function stageAndCommit(deployDir, publishDir, branchDir, message) {
  if (!branchDir.startsWith('pr-')) {
    await cleanup(deployDir);
  }
  regenerateIndex(deployDir, branchDir);

  const publishEntries = readdirSync(publishDir).filter(e => !e.startsWith('.'));
  const toStage = [...publishEntries];
  if (existsSync(join(deployDir, 'index.html'))) toStage.push('index.html');
  if (existsSync(join(deployDir, 'pulls.html'))) toStage.push('pulls.html');
  git(deployDir, 'add', '--force', '--', ...new Set(toStage));
  git(deployDir, 'add', '-A');

  if (noStagedChanges(deployDir)) {
    console.log('No changes to deploy');
    return false;
  }

  console.log('Staged files:');
  try {
    const stat = git(deployDir, 'diff', '--cached', '--stat');
    if (stat) console.log(stat);
  } catch {}

  git(deployDir, 'commit', '-q', '-m', message);
  return true;
}

function tryRebaseAndPush(deployDir, attempt) {
  try {
    git(deployDir, 'pull', '--rebase', 'origin', 'gh-pages');
  } catch {
    console.log('Rebase conflict — resetting to remote');
    try { git(deployDir, 'rebase', '--abort'); } catch {}
    fetchOrCreateGhPages(deployDir);
    return false;
  }
  try {
    git(deployDir, 'push', 'origin', 'gh-pages');
    console.log(`Deployed successfully (attempt ${attempt}, after rebase)`);
    return true;
  } catch {
    console.log('Push failed after rebase, will rebuild');
    fetchOrCreateGhPages(deployDir);
    return false;
  }
}

async function pushWithRetry(deployDir, publishDir, branchDir, message) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 1) {
      applyContent(deployDir, publishDir, branchDir);
    }

    const hasChanges = await stageAndCommit(deployDir, publishDir, branchDir, message);
    if (!hasChanges) return;

    try {
      git(deployDir, 'push', 'origin', 'gh-pages');
      console.log(`Deployed successfully (attempt ${attempt})`);
      return;
    } catch {
      console.log(`Push rejected (attempt ${attempt}/${MAX_RETRIES})`);
      if (attempt < MAX_RETRIES && tryRebaseAndPush(deployDir, attempt)) return;
    }
  }
  throw new Error(`Deploy failed after ${MAX_RETRIES} attempts`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function deploy() {
  // Parse args
  const args = process.argv.slice(2);
  let publishDir = null;
  let message = 'Deploy to GitHub Pages';

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--publish-dir':
        publishDir = args[++i];
        break;
      case '--message':
        message = args[++i];
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        process.exit(1);
    }
  }

  if (!publishDir) {
    console.error('Usage: node deploy-gh-pages.js --publish-dir <dir> [--message <msg>]');
    process.exit(1);
  }

  publishDir = resolve(publishDir);

  // Validate env
  if (!process.env.GITHUB_TOKEN) {
    console.error('GITHUB_TOKEN is required (set by GitHub Actions)');
    process.exit(1);
  }
  if (!process.env.GITHUB_REPOSITORY) {
    console.error('GITHUB_REPOSITORY is required (set by GitHub Actions)');
    process.exit(1);
  }

  // Detect branchDir from publishDir
  const entries = readdirSync(publishDir).filter(e =>
    !e.startsWith('.') && statSync(join(publishDir, e)).isDirectory()
  );

  if (entries.length === 0) {
    console.error('No top-level directory found in publish dir');
    process.exit(1);
  }
  if (entries.length > 1) {
    console.log(`Warning: multiple directories in publish dir: ${entries.join(', ')}; using ${entries[0]}`);
  }

  const branchDir = entries[0];

  // Diagnostics
  console.log(`PUBLISH_DIR: ${publishDir}`);
  console.log('Top-level entries in PUBLISH_DIR:');
  readdirSync(publishDir)
    .filter(e => !e.startsWith('.'))
    .forEach(e => console.log(`  ${e}`));
  console.log(`Branch directory: ${branchDir}`);

  // Create temp git repo
  const deployDir = mkdtempSync(join(tmpdir(), 'deploy-'));
  process.on('exit', () => {
    try { rmSync(deployDir, { recursive: true, force: true }); } catch {}
  });

  git(deployDir, 'init', '-q');
  git(deployDir, 'config', 'user.name', 'github-actions[bot]');
  git(deployDir, 'config', 'user.email', 'github-actions[bot]@users.noreply.github.com');
  const repoUrl = `https://github.com/${process.env.GITHUB_REPOSITORY}.git`;
  git(deployDir, 'remote', 'add', 'origin', repoUrl);
  const credentials = Buffer.from('x-access-token:' + process.env.GITHUB_TOKEN).toString('base64');
  git(deployDir, 'config', `http.${repoUrl}.extraHeader`, `Authorization: Basic ${credentials}`);

  // Fetch gh-pages
  fetchOrCreateGhPages(deployDir);

  // Apply content on first pass
  applyContent(deployDir, publishDir, branchDir);

  // Push with retry handles cleanup, index regeneration, staging, commit, and push
  await pushWithRetry(deployDir, publishDir, branchDir, message);
}

try {
  await deploy();
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}
