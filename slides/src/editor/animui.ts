// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * State the animation pane shares with the canvas: which effects are selected
 * (the move handle draws for one of them; the badges light theirs) and whether
 * the Animate tab is showing. Editor-only and never saved — like the hover-set
 * preview, it is how the author is LOOKING at the deck, not the deck.
 */
export class AnimUI {
  /** selected effect ids, in list order */
  selected: string[] = []
  /** is the Animate tab showing */
  open = false
  /** set by the editor: bring the Animate tab forward (a badge click, "Add animation" from elsewhere) */
  requestOpen: (() => void) | null = null
  private listeners = new Set<() => void>()

  on(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  emit() {
    for (const fn of [...this.listeners]) fn()
  }

  select(ids: string[]) {
    const same = ids.length === this.selected.length && ids.every((id, i) => id === this.selected[i])
    if (same) return
    this.selected = ids
    this.emit()
  }

  setOpen(on: boolean) {
    if (this.open === on) return
    this.open = on
    this.emit()
  }
}
