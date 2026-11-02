import type { HelperPhase } from '../types'
import { type Palette, xml } from './lib'

// Everything drawn as SVG on the desktop. The terminal gets glyphs instead (see register.tsx).
// Text is never put inside a drawing: the app's own text follows the light or dark theme, a picture does not.

// ---------- The crab: one body colour per helper ----------

/** Eight colours that are easy to tell apart. The name goes in the picture's alt text. */
export const HUES: { name: string; color: string }[] = [
  { name: 'red', color: '#dc2626' },
  { name: 'orange', color: '#ea580c' },
  { name: 'yellow', color: '#eab308' },
  { name: 'green', color: '#16a34a' },
  { name: 'teal', color: '#0d9488' },
  { name: 'blue', color: '#2563eb' },
  { name: 'purple', color: '#9333ea' },
  { name: 'pink', color: '#db2777' },
]

export const hueOf = (hue: number) => HUES[((hue % HUES.length) + HUES.length) % HUES.length]!

export const CRAB_PX_W = 48
export const CRAB_PX_H = 36
export const CRAB_FRAMES = 4

// o is body, e is an eye, x a shut eye; every row is 14 cells.
const HEAD = ['..............', '...oooooooo...', '..oooooooooo..']
const LEGS_A = ['....oooooo....', '...o.o..o.o...', '...o.o..o.o...']
const LEGS_B = ['....oooooo....', '..o.o....o.o..', '..o.o....o.o..']
const FRAMES: string[][] = [
  // 0: standing
  [...HEAD, '..oeooooooeo..', '.oooooooooooo.', 'ooo.oooooo.ooo', 'ooo.oooooo.ooo', ...LEGS_A],
  // 1: a hop, legs apart (the whole crab moves up one cell when drawn)
  [...HEAD, '..oeooooooeo..', '.oooooooooooo.', 'ooo.oooooo.ooo', 'ooo.oooooo.ooo', ...LEGS_B],
  // 2: a blink
  [...HEAD, '..oxooooooxo..', '.oooooooooooo.', 'ooo.oooooo.ooo', 'ooo.oooooo.ooo', ...LEGS_A],
  // 3: both claws raised
  ['..............', 'oo.oooooooo.oo', 'o.oooooooooo.o', '..oeooooooeo..', '.oooooooooooo.', '..oooooooooo..', '..oooooooooo..', ...LEGS_B],
]

const EYE = '#2b1d16'
const crabCache = new Map<string, string>()

/** One frame of the crab for a body colour, as an SVG document. Cached: only 32 exist. */
export function crabSvg(hue: number, frame: number): string {
  const f = ((frame % CRAB_FRAMES) + CRAB_FRAMES) % CRAB_FRAMES
  const key = `${((hue % HUES.length) + HUES.length) % HUES.length}:${f}`
  const hit = crabCache.get(key)
  if (hit) return hit
  const rows = FRAMES[f]!
  // Frame 1 hops: it is drawn one cell higher than the others.
  const lift = f === 1 ? 0 : 1
  const cells = new Map<string, 'o' | 'e'>()
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      const c = row[x]
      if (c === 'o' || c === 'e' || c === 'x') cells.set(`${x},${y + lift}`, c === 'o' ? 'o' : 'e')
    }
  })
  // A one-cell outline round the body, so every colour reads on a light and a dark page.
  const ring = new Set<string>()
  for (const k of cells.keys()) {
    const [x, y] = k.split(',').map(Number) as [number, number]
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const n = `${x + dx},${y + dy}`
      if (!cells.has(n)) ring.add(n)
    }
  }
  const color = hueOf(hue).color
  const rect = (k: string, fill: string) => {
    const [x, y] = k.split(',').map(Number) as [number, number]
    return `<rect x="${x + 1}" y="${y + 1}" width="1" height="1" fill="${fill}"/>`
  }
  const parts = [...[...ring].map(k => rect(k, EYE)), ...[...cells].map(([k, c]) => rect(k, c === 'o' ? color : EYE))]
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 12" width="${CRAB_PX_W}" height="${CRAB_PX_H}" shape-rendering="crispEdges">${parts.join('')}</svg>`
  crabCache.set(key, svg)
  return svg
}

// ---------- Sparkles ----------

const CELL = 4

// Fixed noise, so the sparkles sit still between redraws and only their twinkle moves.
const noise = (x: number, y: number) => {
  const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return v - Math.floor(v)
}

/** White dither squares over `w` by `h` pixels: sparse at the left, denser at the right. */
function sparkles(w: number, h: number, size: number, base: number, rise: number, salt = 0): string {
  const cols = Math.floor(w / CELL)
  const rows = Math.max(1, Math.floor(h / CELL))
  const out: string[] = []
  for (let c = 0; c < cols; c += 1) {
    const density = base + rise * Math.pow(c / Math.max(1, cols), 1.3)
    for (let r = 0; r < rows; r += 1) {
      if (noise(c + salt, r) < density) {
        const cls = Math.floor(noise(r, c + salt) * 4)
        out.push(`<rect class="s${cls}" x="${c * CELL + 1}" y="${r * CELL + (h - rows * CELL) / 2 + 1}" width="${size}" height="${size}"/>`)
      }
    }
  }
  return out.join('')
}

/** Twinkle classes s0 to s3, out of phase. A finished bar twinkles slower and softer. */
const twinkleCss = (slow: boolean) =>
  `.s0,.s1,.s2,.s3{animation:tw ${slow ? 3.2 : 2.1}s ease-in-out infinite}` +
  `.s1{animation-duration:${slow ? 3.8 : 2.7}s;animation-delay:-.7s}.s2{animation-duration:${slow ? 4.4 : 1.8}s;animation-delay:-1.3s}` +
  `.s3{animation-duration:${slow ? 3.5 : 3.1}s;animation-delay:-.4s}` +
  `@keyframes tw{0%,100%{opacity:.95}50%{opacity:${slow ? 0.55 : 0.15}}}`

const STILL = '@media (prefers-reduced-motion: reduce){.s0,.s1,.s2,.s3,.lv,.sh,.mv{animation:none}}'

// ---------- The task bar ----------

export const BAR_H = 16

/**
 * The bar track for the task bar, with the "Tasks 2/4" pill at the head of the fill. The title,
 * the percent and the current step are plain text beside it, so they follow the app's theme.
 * `steps` counts every step; `done` those finished; `live` is true while one is in progress.
 */
export function taskBarSvg(o: { done: number; steps: number; live: boolean; width: number; palette: Palette; animate: boolean }): string {
  const { done, steps: n, live, width: W, palette: P, animate } = o
  const H = BAR_H
  const ratio = n ? done / n : 0
  const fillW = Math.round(W * ratio)
  const finished = n > 0 && done === n
  // The step in progress glows softly from the fill to the end of its slot.
  const liveW = live && n ? Math.max(0, Math.round((W * Math.min(n, done + 1)) / n) - fillW) : 0
  const ticks: string[] = []
  // Past about 4 px a slot the ticks only blur, so a long list has none.
  if (n > 1 && W / n >= 5) {
    for (let i = 1; i < n; i += 1) {
      const x = Math.round((W * i) / n)
      if (x > fillW + 3) ticks.push(`<rect x="${x}" y="${H / 2 - 4}" width="1.5" height="8" rx="0.75"/>`)
    }
  }
  const label = `Tasks ${done}/${n}`
  const pillW = Math.round(18 + label.length * 6.4)
  const pillX = Math.max(0, Math.min(W - pillW, fillW - pillW))
  const motion = animate
    ? `${twinkleCss(finished)}.lv{animation:gl 1.6s ease-in-out infinite}@keyframes gl{0%,100%{opacity:.18}50%{opacity:.5}}` +
      `.sh{animation:sw 2.6s linear infinite}@keyframes sw{from{transform:translateX(-70px)}to{transform:translateX(${fillW + 70}px)}}${STILL}`
    : '.lv{opacity:.3}'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>.k{fill:${P.mid};opacity:.2}.tk{fill:${P.deep};opacity:.4}${motion}</style>
<defs>
<linearGradient id="hdb-g" x1="0" x2="1"><stop offset="0" stop-color="${P.light}"/><stop offset=".55" stop-color="${P.mid}"/><stop offset="1" stop-color="${P.deep}"/></linearGradient>
<linearGradient id="hdb-s" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".5"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
<clipPath id="hdb-c"><rect width="${W}" height="${H}" rx="${H / 2}"/></clipPath>
<clipPath id="hdb-f"><rect width="${fillW}" height="${H}"/></clipPath>
</defs>
<rect class="k" width="${W}" height="${H}" rx="${H / 2}"/>
<g clip-path="url(#hdb-c)">
${liveW > 0 ? `<rect class="lv" x="${fillW}" width="${liveW}" height="${H}" fill="${P.mid}"/>` : ''}
${fillW > 0 ? `<rect width="${fillW}" height="${H}" fill="url(#hdb-g)"/>` : ''}
${animate ? `<g fill="#ffffff">${sparkles(fillW, H, 1.6, 0.12, 0.4)}</g>` : ''}
${animate && fillW > 0 && !finished ? `<g clip-path="url(#hdb-f)"><rect class="sh" width="70" height="${H}" fill="url(#hdb-s)"/></g>` : ''}
<g class="tk">${ticks.join('')}</g>
</g>
<rect x="${pillX}" width="${pillW}" height="${H}" rx="${H / 2}" fill="${P.deep}"/>
<text x="${pillX + pillW / 2}" y="${H / 2 + 4}" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif" font-size="11" font-weight="600" fill="#ffffff">${xml(label)}</text>
</svg>`
}

// ---------- A card's bar ----------

export const CARD_BAR_H = 10

/**
 * One thick bar per subagent card. While it works a bright piece sweeps the track (how long a
 * helper takes is not known); once over, the whole bar fills. The drawing depends only on the
 * phase and the width, so CSS moves it and a redraw does not restart it.
 */
export function cardBarSvg(phase: HelperPhase, color: string, W: number, seat: number, failColor: string, animate: boolean): string {
  const H = CARD_BAR_H
  const id = `hdc${seat}`
  const fill = phase === 'failed' ? failColor : color
  const piece = Math.max(30, Math.round(W * 0.35))
  const working = phase === 'working'
  const sweep = animate
    ? `.mv{animation:mv${seat} 1.8s ease-in-out infinite;animation-delay:-${((seat * 0.37) % 1.8).toFixed(2)}s}@keyframes mv${seat}{from{transform:translateX(-${piece}px)}to{transform:translateX(${W}px)}}`
    : `.mv{transform:translateX(${Math.round((W - piece) / 2)}px)}`
  const body = working
    ? `<g class="mv"><rect width="${piece}" height="${H}" fill="url(#${id}-p)"/>${animate ? `<g fill="#ffffff">${sparkles(piece, H, 1.6, 0.1, 0.35, seat * 11)}</g>` : ''}</g>`
    : `<rect width="${W}" height="${H}" fill="url(#${id}-g)"/>${animate ? `<g fill="#ffffff">${sparkles(W, H, 1.6, 0.18, 0.3, seat * 11)}</g>` : ''}`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>${animate ? twinkleCss(!working) : ''}${sweep}${STILL}</style>
<defs>
<linearGradient id="${id}-g" x1="0" x2="1"><stop offset="0" stop-color="${fill}" stop-opacity=".55"/><stop offset="1" stop-color="${fill}"/></linearGradient>
<linearGradient id="${id}-p" x1="0" x2="1"><stop offset="0" stop-color="${fill}" stop-opacity="0"/><stop offset=".7" stop-color="${fill}"/><stop offset="1" stop-color="${fill}" stop-opacity=".9"/></linearGradient>
<clipPath id="${id}-c"><rect width="${W}" height="${H}" rx="${H / 2}"/></clipPath>
</defs>
<g clip-path="url(#${id}-c)">
<rect width="${W}" height="${H}" fill="${fill}" opacity=".16"/>
${body}
</g>
</svg>`
}

// ---------- The live dot ----------

export const DOT_PX = 14

/**
 * A small dot with a ring that swells and fades while Claude works. With animations off, or for a
 * person who asks for less motion, it is a still dot. The word beside it says the state.
 */
export function liveDotSvg(color: string, animate: boolean): string {
  const motion = animate
    ? `.rg{transform-origin:7px 7px;animation:rg 1.8s ease-out infinite}@keyframes rg{from{transform:scale(1);opacity:.65}to{transform:scale(1.7);opacity:0}}` +
      `@media (prefers-reduced-motion: reduce){.rg{animation:none;opacity:0}}`
    : '.rg{opacity:0}'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${DOT_PX}" height="${DOT_PX}" viewBox="0 0 14 14">
<style>${motion}</style>
<circle class="rg" cx="7" cy="7" r="4" fill="none" stroke="${color}" stroke-width="1.5"/>
<circle cx="7" cy="7" r="4" fill="${color}"/>
</svg>`
}
