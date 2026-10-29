// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * FORK: the text of a saved deck's `#bento-doc` — compact JSON, except that the
 * picture data, `assets`, is always the LAST key and starts its own line:
 *
 *   {"$schema":…,"format":"bento/slides",…,"slides":[…],"scripts":{…}}   ← line 1
 *   "assets":{"a-…":"data:image/jpeg;base64,…"}}                          ← line 2
 *
 * (written as `{…,` then a line break then `"assets":…}` — one JSON object).
 * The point is AGENTS: a deck with a 4K picture is megabytes of base64 on
 * that line, and a reader going line by line can now stop before it — the
 * note at the top of every deck says so. The line break is JSON whitespace:
 * every parser, older Bento shells and frozen updaters included, reads the
 * same document. Registered with the kernel by save.ts; scripts/deck-code.mjs
 * carries an identical copy (scripts/test-slides-doc-layout.ts pins the two).
 */
export function docText(doc: object): string {
  const { assets, ...rest } = doc as { assets?: unknown }
  const head = JSON.stringify(rest)
  if (assets === undefined) return head
  return `${head.slice(0, -1)}${head === '{}' ? '' : ','}\n"assets":${JSON.stringify(assets)}}`
}
