/** Screen Share's state for this session. It is read while rows draw, so a change redraws exactly the rows that read it. */
export type ScreenShareMode = {
  /** True while Screen Share hides private data on screen. */
  on: boolean
  /** Until when (ms since the epoch) the real text is shown on purpose (a peek); 0 when not peeking. */
  peekUntil: number
  /** Goes up whenever a rule changes (a word, the style, a category), so every row draws again. */
  v: number
  /** The clock's last tick while a peek runs, so its band counts down. 0 otherwise. */
  tick: number
}

declare module 'claude-code' {
  interface PluginState {
    'screen-share': {
      mode: ScreenShareMode
    }
  }
}
