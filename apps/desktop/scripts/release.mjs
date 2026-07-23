#!/usr/bin/env node
// Cut a release: bump apps/desktop/package.json version, commit, push to main.
// The auto-release.yml workflow turns that push into a signed, notarized
// GitHub release that every installed copy auto-updates to.
//
// Usage (from apps/desktop):
//   bun run release          # patch  1.18.0 -> 1.18.1
//   bun run release:minor    # minor  1.18.0 -> 1.19.0
//   bun run release:major    # major  1.18.0 -> 2.0.0
//   node scripts/release.mjs 1.19.0   # explicit version
//
// Guards: refuses on a dirty tree or off main, so a release never bundles
// unrelated staged work.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkgPath = join(pkgDir, 'package.json')

function git(...args) {
  return execFileSync('git', args, { cwd: pkgDir, encoding: 'utf8' }).trim()
}

function bump(version, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!m) throw new Error(`Cannot bump non-semver version: ${version}`)
  let [maj, min, pat] = m.slice(1).map(Number)
  if (kind === 'major') return `${maj + 1}.0.0`
  if (kind === 'minor') return `${maj}.${min + 1}.0`
  return `${maj}.${min}.${pat + 1}`
}

const arg = process.argv[2] ?? 'patch'
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const current = pkg.version

const next = /^\d+\.\d+\.\d+/.test(arg) ? arg.replace(/^v/, '') : bump(current, arg)

// Preflight: clean tree on main so we ship exactly what's pushed.
if (git('status', '--porcelain')) {
  console.error('✗ Working tree is dirty. Commit or stash before releasing.')
  process.exit(1)
}
const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
if (branch !== 'main') {
  console.error(`✗ On branch "${branch}", not main. Releases cut from main.`)
  process.exit(1)
}

pkg.version = next
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

git('add', 'package.json')
git('commit', '-m', `chore(release): v${next}`)
console.log(`✓ Bumped ${current} -> ${next} and committed.`)

git('push', 'origin', 'main')
console.log(`✓ Pushed to main. auto-release.yml will build and publish v${next}.`)
console.log('  Watch it: gh run watch --workflow=auto-release.yml')
