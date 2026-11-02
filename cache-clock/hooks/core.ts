// Pure helpers for Cache Clock: no engine calls, so they are easy to test.

import type { CacheClockClock, CacheClockWarm } from '../types'

export const FIVE_MIN = 5 * 60_000
export const ONE_HOUR = 60 * 60_000
export const DEMO_MS = 60_000

/** The prices an Anthropic cache read and write are billed at, as a share of the normal input price. */
export const READ_SHARE = 0.1
export const WRITE_SHARE_5M = 1.25
export const WRITE_SHARE_1H = 2

export type Ttl = '5m' | '1h'
export type TtlSource = CacheClockClock['ttlSource']
export type Detected = { ttl: Ttl; source: 'transcript' | 'engine' | 'seen' } | null

export type Settings = {
  cacheLength: 'auto' | Ttl
  readTranscript: boolean
  showCost: boolean
  /** USD per million input tokens; 0 means work it out. */
  inputPrice: number
  bigTokens: number
  handoffCommand: string
  maxPings: number
  maxMs: number
  leadMs: number
}

export const DEFAULTS: Settings = {
  cacheLength: 'auto',
  readTranscript: true,
  showCost: true,
  inputPrice: 0,
  bigTokens: 150_000,
  handoffCommand: 'handoff',
  maxPings: 20,
  maxMs: 90 * 60_000,
  leadMs: 45_000,
}

const num = (v: unknown, fallback: number, min: number, max: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

/** Reads the userConfig values, clamping each to a sane range. Anything odd falls back to the default. */
export function readSettings(options: Readonly<Record<string, unknown>> | undefined): Settings {
  const o = options ?? {}
  const cmd = typeof o.handoff_command === 'string' ? o.handoff_command.trim().replace(/^\//, '') : DEFAULTS.handoffCommand
  return {
    cacheLength: o.cache_length === '5m' || o.cache_length === '1h' ? o.cache_length : 'auto',
    readTranscript: o.read_transcript !== false,
    showCost: o.show_cost !== false,
    inputPrice: num(o.input_price_per_million, DEFAULTS.inputPrice, 0, 1000),
    bigTokens: num(o.big_chat_tokens, DEFAULTS.bigTokens, 0, 5_000_000),
    handoffCommand: /^[A-Za-z0-9_-]{1,64}$/.test(cmd) ? cmd : DEFAULTS.handoffCommand,
    maxPings: Math.round(num(o.warm_max_pings, DEFAULTS.maxPings, 1, 200)),
    maxMs: Math.round(num(o.warm_max_minutes, DEFAULTS.maxMs / 60_000, 5, 720)) * 60_000,
    leadMs: Math.round(num(o.warm_lead_seconds, DEFAULTS.leadMs / 1000, 15, 120)) * 1000,
  }
}

// ---- Text ----

export const short = (tokens: number) => (tokens < 1000 ? String(Math.round(tokens)) : `${Math.round(tokens / 1000)}k`)

export const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export const ago = (ms: number) => {
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'just now'
  if (m === 1) return '1 min ago'
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  return h === 1 ? '1 h ago' : `${h} h ago`
}

/** A span of time in short plain words: "45 s", "12 min", "1 h 30 min". */
export const span = (ms: number) => {
  const s = Math.round(ms / 1000)
  if (s < 90) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const r = m % 60
  return r === 0 ? `${h} h` : `${h} h ${r} min`
}

export const usd = (v: number) => {
  if (!(v > 0)) return ''
  if (v < 0.01) return 'under $0.01'
  if (v < 10) return `$${v.toFixed(2)}`
  return `$${Math.round(v)}`
}

export const ttlName = (ms: number) => (ms >= ONE_HOUR ? '1 hour' : ms === DEMO_MS ? '60 s' : '5 min')

/** Where the cache length comes from, in words. */
export function lengthLabel(c: Pick<CacheClockClock, 'ttlMs' | 'ttlSource'>): string {
  const name = ttlName(c.ttlMs)
  switch (c.ttlSource) {
    case 'demo':
      return '60 s demo cache, this chat only'
    case 'setting':
      return `${name} cache, as set in the Cache Clock settings`
    case 'transcript':
      return `${name} cache, as Anthropic's last reply set it`
    case 'engine':
      return `${name} cache, as Claude Code reported it`
    case 'seen':
      return c.ttlMs >= ONE_HOUR ? '1 hour cache, seen working: it outlived 5 min' : '5 min cache, seen going cold'
    default:
      return '5 min cache, a guess until the first reply'
  }
}

// ---- Cache length ----

export function pickTtl(s: Settings, demo: boolean, d: Detected): { ttlMs: number; ttlSource: TtlSource } {
  if (demo) return { ttlMs: DEMO_MS, ttlSource: 'demo' }
  if (s.cacheLength !== 'auto') return { ttlMs: s.cacheLength === '1h' ? ONE_HOUR : FIVE_MIN, ttlSource: 'setting' }
  if (d) return { ttlMs: d.ttl === '1h' ? ONE_HOUR : FIVE_MIN, ttlSource: d.source }
  return { ttlMs: FIVE_MIN, ttlSource: 'default' }
}

/**
 * Finds which cache length the chat's last cache write used, in the tail of its log file
 * (one JSON object per line). The API reports it per reply as usage.cache_creation:
 * ephemeral_1h_input_tokens and ephemeral_5m_input_tokens. Replies that only read the cache
 * write nothing, so the search goes back to the latest reply that wrote. Subagent rows
 * (isSidechain) are skipped. Returns null when nothing in the text says.
 */
export function ttlFromTranscript(text: string): Ttl | null {
  const MARK = '"ephemeral_1h_input_tokens"'
  let from = text.length
  for (let i = 0; i < 300; i++) {
    const at = text.lastIndexOf(MARK, from)
    if (at < 0) return null
    const start = text.lastIndexOf('\n', at) + 1
    let end = text.indexOf('\n', at)
    if (end < 0) end = text.length
    try {
      const row = JSON.parse(text.slice(start, end)) as {
        type?: string
        isSidechain?: boolean
        message?: { usage?: { cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number } } }
      }
      const cc = row.type === 'assistant' && !row.isSidechain ? row.message?.usage?.cache_creation : undefined
      if (cc) {
        if ((cc.ephemeral_1h_input_tokens ?? 0) > 0) return '1h'
        if ((cc.ephemeral_5m_input_tokens ?? 0) > 0) return '5m'
      }
    } catch {
      // The first line of a tail read is cut in half, or the line is not JSON: look further back.
    }
    if (start === 0) return null
    from = start - 1
  }
  return null
}

// ---- Clock state ----

export const isCold = (c: CacheClockClock, now: number) => c.coldAt > 0 || now - c.lastEnd >= c.ttlMs

/** How long it has been cold, in ms (0 when warm). */
export const coldFor = (c: CacheClockClock, now: number) => (c.coldAt > 0 ? now - c.coldAt : Math.max(0, now - c.lastEnd - c.ttlMs))

// ---- Cost ----

/** A rough list-price guess, in USD per million input tokens, by model family. 0 means unknown. */
export function listInputPrice(model: string): number {
  const m = model.toLowerCase()
  if (m.includes('opus')) return /opus-4-(0|1)\b|opus-4-2025|claude-3-opus|opus-4$/.test(m) ? 15 : 5
  if (m.includes('sonnet')) return 3
  if (m.includes('haiku')) return /haiku-3-5/.test(m) ? 0.8 : /claude-3-haiku/.test(m) ? 0.25 : 1
  return 0
}

export const writeShare = (ms: number) => (ms >= ONE_HOUR ? WRITE_SHARE_1H : WRITE_SHARE_5M)

/** Cost, in USD, of a message that reads the chat from cache and of one that writes it again. */
export function costOf(tokens: number, ttlMs: number, usdPerToken: number) {
  return { warm: tokens * usdPerToken * READ_SHARE, cold: tokens * usdPerToken * writeShare(ttlMs) }
}

/** What the pings of one keep-warm run have cost so far, in USD. 0 when the price is not known. */
export function warmSpent(w: CacheClockWarm, ttlMs: number, usdPerToken: number) {
  return (w.readTotal * READ_SHARE + w.writeTotal * writeShare(ttlMs) + w.outTotal * 5) * usdPerToken
}

// ---- Keep warm text ----

export function warmLine(w: CacheClockWarm, untilPing: number, spent: string): string {
  const parts = ['Keeping warm']
  if (w.sending) parts.push(`sending ping ${w.pings + 1} of ${w.maxPings}`)
  else if (w.pings === 0) parts.push(`first ping in ${mmss(untilPing)}`, `up to ${w.maxPings} pings or ${span(w.maxMs)}`)
  else parts.push(`ping ${w.pings} of ${w.maxPings}`, `next in ${mmss(untilPing)}`)
  if (w.error) parts.push(`last ping failed (${w.error}), trying again`)
  else if (w.pings > 0 && w.cold) parts.push(`the cache had gone cold, so ping ${w.pings} wrote ${short(w.write)} tokens to it again`)
  else if (w.pings > 0) parts.push(`last ping read ${short(w.read)} cached tokens`)
  if (spent) parts.push(`${spent} spent so far`)
  return parts.join(' · ')
}

// ---- Files ----

/** Parses a JSON object; anything else (broken, an array, a number) is undefined. */
export function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const json = JSON.parse(text) as unknown
    return json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}
