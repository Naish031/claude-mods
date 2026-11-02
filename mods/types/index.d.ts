/** The short line under the list after a press: "Cache Clock is off in every chat." */
export type Note = {
  text: string
  /** `warn` draws it as a problem, `ok` as a confirmation. */
  tone: 'ok' | 'warn'
  /** Clock time it was said; the pane stops showing it after 90 seconds. */
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    mods: {
      note: Shaped<Note>
      /** The text in the filter box. */
      filter: string
      /** The mod whose "off" press is waiting for a second press ("mods" only). */
      armed: string
      /** What Undo would revert, "Cache Clock off"; empty when there is nothing to undo. */
      undo: string
      /** Bumped when the file or the list changed on disk, so an open pane redraws. */
      rev: number
    }
  }
}
