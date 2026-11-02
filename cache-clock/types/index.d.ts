/** One chat's cache clock: when the cache was last refreshed and how long it lasts. */
export type CacheClockClock = {
  /** When the cache was last refreshed (a finished reply or a ping), in ms. 0 before the first reply. */
  lastEnd: number
  /** How long the cache stays warm after that, in ms. */
  ttlMs: number
  /**
   * Where ttlMs comes from. setting: the Cache length setting. transcript: the last reply's own
   * usage, read from the chat log. engine: Claude Code's figure at a model switch. seen: worked out
   * from a ping or a reply. default: a 5 min guess. demo: 60 s for filming, this chat only.
   */
  ttlSource: 'setting' | 'transcript' | 'engine' | 'seen' | 'default' | 'demo'
  /** Context tokens the next message re-sends. 0 when not known (after a compaction). */
  tokens: number
  /** Model id the cache belongs to; '' when not known. */
  model: string
  /** The clock's last tick, in ms, so the band redraws every second. */
  now: number
  /** When the cache was lost before its time ran out (model change, compaction), in ms; 0 when not. */
  coldAt: number
  /** Why coldAt is set. */
  coldReason: '' | 'model' | 'compact'
  /** A line under the band after a button press. */
  note: string
}

/** Keep warm for one chat. It exists only while keep warm is on. */
export type CacheClockWarm = {
  /** When keep warm was turned on, in ms. */
  startedAt: number
  /** Pings sent so far. */
  pings: number
  /** Most pings: the cap that was in force when it was turned on. */
  maxPings: number
  /** Most time, in ms: the cap in force when it was turned on. */
  maxMs: number
  /** How long before the cache goes cold a ping goes out, in ms. */
  leadMs: number
  /** Cache read tokens of the last ping. */
  read: number
  /** Cache write tokens of the last ping. */
  write: number
  /** Cache read tokens over all pings. */
  readTotal: number
  /** Cache write tokens over all pings. */
  writeTotal: number
  /** Output tokens over all pings. */
  outTotal: number
  /** True when the last ping wrote the chat to the cache again: it had gone cold. */
  cold: boolean
  /** Why the last ping failed, or ''. */
  error: string
  /** True while a ping is out. */
  sending: boolean
  /** Failed pings in a row: it stops after 3. */
  failures: number
  /** No new ping before this time, in ms (after a failure). */
  retryAt: number
  /** True when it was turned on while the cache was already cold: the first ping may re-write it. */
  allowCold: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'cache-clock': { clock: CacheClockClock | null; warm: CacheClockWarm | null }
  }
}
