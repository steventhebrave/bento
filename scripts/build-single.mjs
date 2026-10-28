#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The platform-neutral half of an app's `build:single` (FORK).
//
//   node ../scripts/build-single.mjs <outDir> <shell name> [KEY=VALUE …]
//
// Runs, from the app's directory: `tsc -b`, then `vite build --outDir
// <outDir>` with SINGLEFILE=1 (plus any KEY=VALUE given), then renames
// <outDir>/index.html to <outDir>/<shell name>. postbuild-compress.mjs runs
// after it, from package.json, unchanged.
//
// Why a script: the old one-liner (`SINGLEFILE=1 vite build … && mv …`) is
// POSIX shell. On Windows npm runs scripts through cmd.exe, which has neither
// an inline environment assignment nor `mv`, so the build could not run there
// at all. This calls both tools through node, so no shell is involved, and
// says plainly when the app's dependencies are not installed (cmd's answer
// was "'tsc' is not recognized as an internal or external command").

import { spawnSync } from 'node:child_process'
import { existsSync, renameSync } from 'node:fs'
import { join, relative } from 'node:path'

const [outDir, name, ...envArgs] = process.argv.slice(2)
if (!outDir || !name) {
  console.error('usage: node ../scripts/build-single.mjs <outDir> <shell name> [KEY=VALUE …]')
  process.exit(2)
}
const app = process.cwd()
const bin = (pkg, file) => join(app, 'node_modules', pkg, ...file.split('/'))
const tsc = bin('typescript', 'bin/tsc')
const vite = bin('vite', 'bin/vite.js')
if (!existsSync(tsc) || !existsSync(vite)) {
  console.error(`build-single: this app's dependencies are not installed (no ${relative(app, existsSync(tsc) ? vite : tsc)}).`)
  console.error(`Run \`npm install\` in ${app} first, then build again.`)
  process.exit(1)
}

const run = (label, args, env = process.env) => {
  const r = spawnSync(process.execPath, args, { cwd: app, env, stdio: 'inherit' })
  if (r.status !== 0) {
    console.error(`build-single: ${label} failed${r.error ? `: ${r.error.message}` : ''}`)
    process.exit(r.status || 1)
  }
}

run('tsc -b', [tsc, '-b'])
const env = { ...process.env, SINGLEFILE: '1' }
for (const kv of envArgs) {
  const i = kv.indexOf('=')
  if (i < 1) { console.error(`build-single: "${kv}" is not KEY=VALUE`); process.exit(2) }
  env[kv.slice(0, i)] = kv.slice(i + 1)
}
run('vite build', [vite, 'build', '--outDir', outDir], env)
const built = join(app, outDir, 'index.html')
if (!existsSync(built)) { console.error(`build-single: vite wrote no ${relative(app, built)}`); process.exit(1) }
renameSync(built, join(app, outDir, name))
