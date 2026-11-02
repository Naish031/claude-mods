import { expect, test } from 'claude-code/testing'

import type { ReplayStep, ReplayTurn } from '../types'
import { foldReason, hasNul, isBinaryPath, labelOf, languageOf } from './classify'
import { capHunks, charTotal, clip, countHunks, diffOps, diffTexts, hunksFromPatch, isGap, locate, LINE_MAX, lineTotal, pairRows, patchOf, rowsOf, splitLines, unifiedText, wholeHunk } from './diff'
import { appendLog, errText, logLine, openRequestPath, parseFlags, patchPath, withHidden } from './infra'
import { clamp, groupOfStep, groupsOf, HELP, hintText, parseCommand, parseFilter, matches, patchForSteps, plural, readSettings, stepsOfGroup, stripRange, totals, trimHistory, turnAt, turnLine, visibleSteps, windowChunks } from './model'
import { displayPath, parseShell, stepsForCall, stepsForShell, type Ctx } from './record'

// Pure helpers. They never touch the engine, so each test just checks values.

const CTX: Ctx = { cwd: '/Users/test/shop', home: '/Users/test', collapse: 300, now: 1_800_000_000_000, budget: 700_000, helper: false }
const lines = (n: number, p = 'l') => Array.from({ length: n }, (_, i) => `${p}${i + 1}`)

const step = (over: Partial<ReplayStep> = {}): ReplayStep => ({
  id: 'x',
  tool: 'Edit',
  file: 'a.js',
  abs: '/Users/test/shop/a.js',
  from: '',
  kind: 'edit',
  note: '',
  hunks: [],
  add: 1,
  del: 1,
  more: 0,
  known: true,
  helper: false,
  label: '',
  lang: '',
  why: '',
  at: 0,
  ...over,
})

// ---------------------------------------------------------------------------------------------
// diff.ts
// ---------------------------------------------------------------------------------------------

test('the diff keeps the most lines and rebuilds both sides, on 2000 random pairs', async () => {
  let seed = 12345
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed % n
  }
  for (let t = 0; t < 2000; t += 1) {
    const a = Array.from({ length: rnd(25) }, () => String(rnd(5)))
    const b = Array.from({ length: rnd(25) }, () => String(rnd(5)))
    const ops = diffOps(a, b)
    let i = 0
    let j = 0
    for (const op of ops) {
      if (op === ' ') {
        expect(a[i]).toBe(b[j])
        i++
        j++
      } else if (op === '-') i++
      else j++
    }
    expect([i, j]).toEqual([a.length, b.length])
    const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
    for (let x = a.length - 1; x >= 0; x--) for (let y = b.length - 1; y >= 0; y--) dp[x]![y] = a[x] === b[y] ? dp[x + 1]![y + 1]! + 1 : Math.max(dp[x + 1]![y]!, dp[x]![y + 1]!)
    expect(ops.filter(o => o === ' ').length).toBe(dp[0]![0])
  }
})

test('hunks carry real line numbers, merge near changes and split far ones', async () => {
  const a = lines(30).join('\n')
  const b = a.replace('l5\n', 'L5\n').replace('l8\n', '').replace('l25\n', 'l25\nextra\n')
  const h = diffTexts(a, b)
  expect(h.length).toBe(2)
  expect(h[0]).toMatchObject({ oldStart: 2, newStart: 2, oldLines: 10, newLines: 9 })
  expect(h[0]!.lines.filter(l => l[0] !== ' ')).toEqual(['-l5', '+L5', '-l8'])
  expect(h[1]).toMatchObject({ oldStart: 23, newStart: 22 })
  expect(countHunks(h)).toEqual({ add: 2, del: 2 })
  // The same change with an offset: the snippet sits at line 40.
  const at = diffTexts('x\ny', 'x\nz', 40)
  expect(at[0]).toMatchObject({ oldStart: 40, newStart: 40 })
  expect(diffTexts('same', 'same')).toEqual([])
  expect(diffTexts('', '')).toEqual([])
})

test('a new file, a deleted file and a pure insertion are numbered the usual way', async () => {
  expect(unifiedText(rowsOf(wholeHunk('a\nb', '+')))).toBe('@@ -0,0 +1,2 @@\n+a\n+b')
  expect(unifiedText(rowsOf(wholeHunk('a\nb\n', '-')))).toBe('@@ -1,2 +0,0 @@\n-a\n-b')
  expect(unifiedText(rowsOf(diffTexts('', 'x\ny')))).toBe('@@ -0,0 +1,2 @@\n+x\n+y')
  expect(wholeHunk('', '+')).toEqual([])
  const ins = diffTexts('a\nb\nc\nd\ne\nf\ng', 'a\nb\nc\nX\nd\ne\nf\ng')
  expect(unifiedText(rowsOf(ins))).toBe('@@ -1,6 +1,7 @@\n a\n b\n c\n+X\n d\n e\n f')
  // The tool's own style for an insert-only hunk: it names the line before.
  const rows = rowsOf([{ oldStart: 5, oldLines: 0, newStart: 6, newLines: 1, lines: ['+x'] }])
  expect(rows[0]).toMatchObject({ o: 6, n: 6 })
  expect(unifiedText(rows)).toBe('@@ -5,0 +6 @@\n+x')
})

test('the tool\'s structuredPatch is checked: bad shapes are refused, "No newline" lines dropped, long lines clipped', async () => {
  expect(hunksFromPatch(undefined)).toBeNull()
  expect(hunksFromPatch([])).toBeNull()
  expect(hunksFromPatch('x')).toBeNull()
  expect(hunksFromPatch([{ oldStart: 'a', newStart: 1, lines: [] }])).toBeNull()
  expect(hunksFromPatch([{ oldStart: 1, newStart: 1, lines: [5] }])).toBeNull()
  expect(hunksFromPatch([{ oldStart: 1, newStart: 1, lines: ['?x'] }])).toBeNull()
  expect(hunksFromPatch([null])).toBeNull()
  const ok = hunksFromPatch([{ oldStart: 3, newStart: 3, oldLines: 99, newLines: 99, lines: [' a', '-b', '+c', '\\ No newline at end of file', `+${'x'.repeat(2000)}`] }])!
  expect(ok[0]!.lines.length).toBe(4)
  expect(ok[0]).toMatchObject({ oldStart: 3, oldLines: 2, newStart: 3, newLines: 3 })
  expect(ok[0]!.lines[3]!.length).toBe(1 + LINE_MAX + 2)
  expect(clip('short')).toBe('short')
})

test('capping a diff keeps the start, fixes the counts and says how much is left', async () => {
  const h = wholeHunk(lines(100).join('\n'), '+')
  const r = capHunks(h, 30, 1_000_000)
  expect(lineTotal(r.hunks)).toBe(30)
  expect(r.more).toBe(70)
  expect(r.hunks[0]).toMatchObject({ newLines: 30, oldLines: 0 })
  const bytes = capHunks(h, 100, 40)
  expect(lineTotal(bytes.hunks)).toBeLessThan(15)
  expect(capHunks(h, 100, 0).hunks).toEqual([])
  expect(capHunks(h, 100, 0).more).toBe(100)
  expect(charTotal(h)).toBeGreaterThan(300)
  const two = capHunks([...h, ...h], 120, 1_000_000)
  expect(two.hunks.length).toBe(2)
  expect(lineTotal(two.hunks)).toBe(120)
})

test('windows of a diff are valid unified text with their own headers', async () => {
  const a = lines(60).join('\n')
  const b = a.replace('l5\n', 'L5\n').replace('l50\n', 'L50\n')
  const rows = rowsOf(diffTexts(a, b))
  expect(rows.length).toBe(16)
  const first = unifiedText(rows, 0, 5)
  expect(first.startsWith('@@ -2,4 +2,4 @@')).toBe(true)
  const mid = unifiedText(rows, 4, 12)
  expect(mid.match(/^@@/gm)?.length).toBe(2)
  expect(unifiedText(rows, 3, 3)).toBe('')
  // Window headers add up: the old-side count of every part equals the rows that are not additions.
  const whole = unifiedText(rows)
  const parts = [...whole.matchAll(/^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@$/gm)]
  expect(parts.length).toBe(2)
})

test('side by side pairs a run of removed lines with the run of added lines after it', async () => {
  const rows = rowsOf([{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 4, lines: [' a', '-b', '-c', '-d', '+X', '+Y', ' e'] }])
  const pairs = pairRows(rows)
  expect(pairs.map(p => [p.l?.t ?? null, p.r?.t ?? null])).toEqual([
    ['a', 'a'],
    ['b', 'X'],
    ['c', 'Y'],
    ['d', null],
    ['e', 'e'],
  ])
  const two = pairRows(rowsOf([{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [' a'] }, { oldStart: 9, oldLines: 1, newStart: 9, newLines: 1, lines: [' z'] }]))
  expect(isGap(two, 1)).toBe(true)
  expect(isGap(two, 0)).toBe(false)
  expect(isGap(two, 2)).toBe(false)
  expect(pairRows([])).toEqual([])
})

test('locate finds the first line of a snippet and counts its places', async () => {
  expect(locate('a\nb\nfoo\nc\nfoo', 'foo')).toEqual({ line: 3, count: 2 })
  expect(locate('x', 'nope')).toBeNull()
  expect(locate('x', '')).toBeNull()
  expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b'])
  expect(splitLines('\n')).toEqual([''])
  expect(splitLines(undefined)).toEqual([])
})

test('patchOf writes a patch for each kind of step', async () => {
  const hunks = diffTexts('a\nb', 'a\nc')
  const edit = patchOf(step({ hunks }))
  expect(edit).toContain('diff --git a//Users/test/shop/a.js b//Users/test/shop/a.js')
  expect(edit).toContain('--- a//Users/test/shop/a.js\n+++ b//Users/test/shop/a.js\n@@ -1,2 +1,2 @@')
  expect(patchOf(step({ kind: 'create', hunks: wholeHunk('n', '+') }))).toContain('--- /dev/null')
  expect(patchOf(step({ kind: 'delete', hunks: wholeHunk('n', '-') }))).toContain('+++ /dev/null')
  expect(patchOf(step({ kind: 'delete' }))).toContain('deleted (nothing to list)')
  expect(patchOf(step({ kind: 'create' }))).toContain('new file (empty)')
  expect(patchOf(step({ kind: 'binary' }))).toContain('Binary file')
  const rename = patchOf(step({ kind: 'rename', from: '/Users/test/shop/old.js' }))
  expect(rename).toContain('rename from /Users/test/shop/old.js')
  expect(rename).toContain('rename to /Users/test/shop/a.js')
  expect(patchOf(step({ note: 'same content' }))).toContain('# same content')
  const unknown = patchOf(step({ hunks, known: false, more: 4 }))
  expect(unknown.startsWith('# line numbers are a guess')).toBe(true)
  expect(unknown).toContain('# 4 more lines were not kept')
})

// ---------------------------------------------------------------------------------------------
// classify.ts
// ---------------------------------------------------------------------------------------------

test('languages: Liquid reads as HTML, JSON as JSON, unknown files are left to the engine', async () => {
  expect(languageOf('sections/hero.liquid')).toBe('html')
  expect(languageOf('templates/index.json')).toBe('json')
  expect(languageOf('assets/app.js')).toBe('javascript')
  expect(languageOf('a/b.tsx')).toBe('tsx')
  expect(languageOf('x.PY')).toBe('python')
  expect(languageOf('Makefile')).toBe('')
  expect(languageOf('.env')).toBe('')
  expect(languageOf('a.unknownext')).toBe('')
})

test('Shopify theme files get a plain label', async () => {
  const l = labelOf
  expect(l('sections/hero.liquid')).toBe('Liquid section')
  expect(l('theme/snippets/price.liquid')).toBe('Liquid snippet')
  expect(l('layout/theme.liquid')).toBe('Liquid layout')
  expect(l('blocks/card.liquid')).toBe('Liquid block')
  expect(l('templates/product.json')).toBe('JSON template')
  expect(l('templates/customers/account.json')).toBe('JSON template')
  expect(l('templates/page.contact.liquid')).toBe('Liquid template')
  expect(l('sections/header-group.json')).toBe('Section group')
  expect(l('config/settings_data.json')).toBe('Theme settings data')
  expect(l('config/settings_schema.json')).toBe('Theme settings schema')
  expect(l('locales/en.default.json')).toBe('Locale')
  expect(l('assets/theme.js')).toBe('Theme script')
  expect(l('assets/theme.css')).toBe('Theme style')
  expect(l('assets/base.css.liquid')).toBe('Theme style')
  expect(l('misc/other.liquid')).toBe('Liquid')
  expect(l('src/app.ts')).toBe('')
})

test('what folds: generated names, long lines, and a change past the limit', async () => {
  const none = [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+x'] }]
  expect(foldReason('assets/app.min.js', none, 1, 300)).toBe('minified file')
  expect(foldReason('assets/a.css.map', none, 1, 300)).toBe('source map')
  expect(foldReason('package-lock.json', none, 1, 300)).toBe('lock file')
  expect(foldReason('shop/yarn.lock', none, 1, 300)).toBe('lock file')
  expect(foldReason('dist/x.js', none, 1, 300)).toBe('generated or vendored folder')
  expect(foldReason('a.snap', none, 1, 300)).toBe('test snapshot')
  expect(foldReason('config/settings_data.json', none, 1, 300), 'a small edit to settings_data is not folded').toBe('')
  expect(foldReason('x.js', [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: [`+${'a'.repeat(700)}`] }], 1, 300)).toMatch(/very long lines/)
  expect(foldReason('x.js', none, 301, 300)).toBe('large change, 301 lines')
  expect(foldReason('x.js', none, 300, 300)).toBe('')
  expect(foldReason('x.js', none, 99_999, 0)).toBe('')
  expect(hasNul('a\u0000b')).toBe(true)
  expect(hasNul('ab')).toBe(false)
  expect(hasNul(undefined)).toBe(false)
  expect(isBinaryPath('a/logo.PNG')).toBe(true)
  expect(isBinaryPath('a/logo.svg')).toBe(false)
})

// ---------------------------------------------------------------------------------------------
// record.ts
// ---------------------------------------------------------------------------------------------

test('displayPath shows a path relative to the folder, ~/ for the home folder, else as given', async () => {
  expect(displayPath('/Users/test/shop/a/b.js', CTX.cwd, CTX.home)).toBe('a/b.js')
  expect(displayPath('/Users/test/other/b.js', CTX.cwd, CTX.home)).toBe('~/other/b.js')
  expect(displayPath('/etc/hosts', CTX.cwd, CTX.home)).toBe('/etc/hosts')
  expect(displayPath('/Users/test/shopping/x', CTX.cwd, CTX.home), 'a sibling that shares the start is not inside').toBe('~/shopping/x')
  expect(displayPath('', CTX.cwd, CTX.home)).toBe('(unknown file)')
  expect(displayPath('/x/y', '', '')).toBe('/x/y')
  expect(displayPath('/Users/test/shop/a', '/Users/test/shop/', CTX.home)).toBe('a')
})

test('steps from a finished Edit: the tool\'s own patch wins, else the snippet at its place, else the snippet alone', async () => {
  const input = { tool: 'Edit', tool_use_id: 'e1', file_path: '/Users/test/shop/sections/x.liquid', old_string: 'one\ntwo', new_string: 'one\n2' }
  const withPatch = stepsForCall(input, { structuredPatch: [{ oldStart: 7, newStart: 7, oldLines: 3, newLines: 3, lines: [' c', ' one', '-two', '+2'] }], originalFile: 'x' }, CTX)
  expect(withPatch.length).toBe(1)
  expect(withPatch[0]).toMatchObject({ id: 'e1', tool: 'Edit', file: 'sections/x.liquid', kind: 'edit', known: true, add: 1, del: 1, label: 'Liquid section', lang: 'html', why: '', helper: false, at: CTX.now })
  expect(withPatch[0]!.hunks[0]).toMatchObject({ oldStart: 7, oldLines: 3, newLines: 3 })
  const located = stepsForCall(input, { originalFile: 'a\nb\none\ntwo\nz' }, CTX)
  expect(located[0]).toMatchObject({ known: true })
  expect(located[0]!.hunks[0]).toMatchObject({ oldStart: 3 })
  const alone = stepsForCall(input, undefined, CTX)
  expect(alone[0]).toMatchObject({ known: false })
  expect(alone[0]!.hunks[0]).toMatchObject({ oldStart: 1 })
  const all = stepsForCall({ ...input, replace_all: true }, { originalFile: 'one\ntwo\nx\none\ntwo', userModified: true }, CTX)
  expect(all[0]!.note).toBe('replace all, 2 places, you changed it first')
  expect(stepsForCall({ ...input, replace_all: true }, undefined, CTX)[0]!.note).toBe('replace all')
  expect(stepsForCall({ ...input, replace_all: true }, { originalFile: 'one\ntwo' }, CTX)[0]!.note).toBe('replace all')
  expect(stepsForCall({ ...input, tool_use_id: undefined }, {}, CTX)[0]!.id).toMatch(/^call-/)
})

test('steps from a finished Write: create, rewrite, same, held, binary, too large', async () => {
  const w = (res: Record<string, unknown>, content = 'a\nb', file = '/Users/test/shop/n.txt') => stepsForCall({ tool: 'Write', tool_use_id: 'w', file_path: file, content }, res, CTX)
  expect(w({ type: 'create', structuredPatch: [], originalFile: null })[0]).toMatchObject({ kind: 'create', note: 'new file', add: 2, del: 0, known: true })
  expect(w({ type: 'update', originalFile: 'a\nx\n', structuredPatch: [] })[0]).toMatchObject({ kind: 'rewrite', note: 'rewrite', add: 1, del: 1 })
  expect(w({ type: 'update', originalFile: 'a\nx\n', structuredPatch: [{ oldStart: 1, newStart: 1, lines: [' a', '-x', '+b'] }] })[0]).toMatchObject({ kind: 'rewrite', add: 1, del: 1 })
  expect(w({ type: 'update', originalFile: 'a\nb\n', structuredPatch: [] })[0]).toMatchObject({ kind: 'unchanged', note: 'rewritten with the same content' })
  expect(w({ type: 'update', originalFile: 'x', staged: true })).toEqual([])
  expect(w({ type: 'create' }, 'x', '/Users/test/shop/logo.png')[0]).toMatchObject({ kind: 'binary' })
  expect(w({ type: 'create' }, 'a\u0000b')[0]).toMatchObject({ kind: 'binary' })
  expect(w({ type: 'create', userModified: true }, 'x', '/Users/test/shop/x.woff2')[0]!.note).toMatch(/new binary file, 1 bytes, you changed it first/)
  expect(w({ type: 'update', originalFile: null, structuredPatch: [] })[0]).toMatchObject({ kind: 'rewrite', known: false })
  expect(w({ type: 'update', originalFile: null, structuredPatch: [] })[0]!.note).toMatch(/too large to compare/)
  expect(w({ type: 'create', userModified: true })[0]!.note).toBe('new file, you changed it first')
  const unknown = stepsForCall({ tool: 'Write', tool_use_id: 'w', file_path: '/Users/test/shop/q.txt', content: 'a' }, undefined, CTX)
  expect(unknown[0]).toMatchObject({ kind: 'rewrite', known: false })
  expect(unknown[0]!.note).toMatch(/did not say which/)
})

test('steps from MultiEdit and NotebookEdit', async () => {
  const multi = stepsForCall({ tool: 'MultiEdit', tool_use_id: 'm', file_path: '/Users/test/shop/m.js', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'b', new_string: 'c', replace_all: true }, { old_string: 'zz', new_string: 'y' }] }, { originalFile: 'x\na\nq' }, CTX)
  expect(multi.map(s => s.id)).toEqual(['m#1', 'm#2', 'm#3'])
  expect(multi.map(s => s.note)).toEqual(['edit 1 of 3', 'edit 2 of 3, replace all', 'edit 3 of 3'])
  expect(multi[0]!.hunks[0]).toMatchObject({ oldStart: 2 })
  expect(multi[1]!.hunks[0]).toMatchObject({ oldStart: 2 }) // found in the working copy after edit 1
  expect(multi[2]!.known).toBe(false)
  expect(stepsForCall({ tool: 'MultiEdit', tool_use_id: 'm', file_path: '/x', edits: 'nope' }, {}, CTX)).toEqual([])
  const nb = (res: Record<string, unknown>, input: Record<string, unknown> = {}) => stepsForCall({ tool: 'NotebookEdit', tool_use_id: 'n', notebook_path: '/Users/test/shop/n.ipynb', ...input }, res, CTX)
  expect(nb({ old_source: 'a', new_source: 'b', edit_mode: 'replace', cell_id: 'c1', cell_type: 'code' })[0]).toMatchObject({ kind: 'notebook', note: 'cell c1, replace, code', add: 1, del: 1, known: false, lang: '' })
  expect(nb({ new_source: 'x\ny', edit_mode: 'insert', cell_type: 'markdown' })[0]).toMatchObject({ add: 2, del: 0, note: 'cell, insert, markdown' })
  expect(nb({ old_source: 'x\ny', new_source: '', edit_mode: 'delete' })[0]).toMatchObject({ add: 0, del: 2 })
  expect(nb({ error: 'bad cell' })).toEqual([])
  expect(nb({}, { new_source: 'z', cell_id: 'q' })[0]).toMatchObject({ add: 1, note: 'cell q, replace' })
})

test('the budget: a step past the turn\'s budget keeps counts only, and a long one keeps its start', async () => {
  const content = lines(3000).join('\n')
  const input = { tool: 'Write', tool_use_id: 'b', file_path: '/Users/test/shop/b.txt', content }
  const res = { type: 'create', structuredPatch: [], originalFile: null }
  const none = stepsForCall(input, res, { ...CTX, budget: 0 })[0]!
  expect(none).toMatchObject({ add: 3000, hunks: [], more: 3000 })
  expect(none.note).toMatch(/diff not kept/)
  const some = stepsForCall(input, res, CTX)[0]!
  expect(some.add).toBe(3000)
  expect(lineTotal(some.hunks)).toBe(2000)
  expect(some.more).toBe(1000)
  expect(some.why).toMatch(/large change, 3000 lines/)
  const second = stepsForCall({ ...input, tool: 'MultiEdit', edits: [{ old_string: 'a', new_string: lines(100, 'long line number ').join('\n') }, { old_string: 'a', new_string: 'b' }] }, {}, { ...CTX, budget: 500 })
  expect(second.length).toBe(2)
  expect(second[0]!.more).toBeGreaterThan(0)
})

test('parseShell reads plain rm, mv, git rm and git mv, and nothing it is unsure of', async () => {
  const cwd = '/Users/test/shop'
  const p = (c: string) => parseShell(c, cwd)
  expect(p('rm a.txt')).toEqual([{ op: 'rm', path: '/Users/test/shop/a.txt' }])
  expect(p('rm -rf ./x/../y "my file.txt" /abs/z')).toEqual([
    { op: 'rm', path: '/Users/test/shop/y' },
    { op: 'rm', path: '/Users/test/shop/my file.txt' },
    { op: 'rm', path: '/abs/z' },
  ])
  expect(p("mv a b && git mv 'c d' e; git rm -f f")).toEqual([
    { op: 'mv', from: '/Users/test/shop/a', to: '/Users/test/shop/b' },
    { op: 'mv', from: '/Users/test/shop/c d', to: '/Users/test/shop/e' },
    { op: 'rm', path: '/Users/test/shop/f' },
  ])
  expect(p('mv a b c dir/')).toEqual([
    { op: 'mv', from: '/Users/test/shop/a', to: '/Users/test/shop/dir' },
    { op: 'mv', from: '/Users/test/shop/b', to: '/Users/test/shop/dir' },
    { op: 'mv', from: '/Users/test/shop/c', to: '/Users/test/shop/dir' },
  ])
  expect(p('mkdir -p x && mv a x/ && ls')).toEqual([{ op: 'mv', from: '/Users/test/shop/a', to: '/Users/test/shop/x' }])
  expect(p('rm -- -weird')).toEqual([{ op: 'rm', path: '/Users/test/shop/-weird' }])
  for (const unsure of ['ls | xargs rm', 'rm *.txt', 'rm $F', 'rm `x`', 'rm "$F"', 'rm a > log', 'rm a || true', 'rm a &', 'cd x && rm a', 'rm ~/a', 'rm (a)', 'rm {a,b}', "rm 'a", 'rm a\nrm b', 'mv -t dir a', 'mv --target-directory=d a', 'git rm --cached a', 'git mv -n a b', 'rm a # c', 'echo rm', 'rm', 'mv a', 'git status', '']) {
    expect(p(unsure), unsure).toEqual([])
  }
  expect(parseShell('rm a', '')).toEqual([])
  expect(parseShell('rm /abs/a', '')).toEqual([{ op: 'rm', path: '/abs/a' }])
  expect(p(`rm ${'a'.repeat(1600)}`)).toEqual([])
  expect(p(Array.from({ length: 25 }, (_, i) => `rm f${i}`).join(' && '))).toEqual([])
})

test('stepsForShell: removed files as removed lines, folders, binary, moves, renames, and what was not there', async () => {
  const facts = {
    '/Users/test/shop/a.txt': { kind: 'file' as const, text: 'x\ny' },
    '/Users/test/shop/dir': { kind: 'dir' as const, text: null },
    '/Users/test/shop/logo.png': { kind: 'file' as const, text: null },
    '/Users/test/shop/big.txt': { kind: 'file' as const, text: null },
    '/Users/test/shop/gone': { kind: 'none' as const, text: null },
    '/Users/test/shop/m.txt': { kind: 'file' as const, text: null },
    '/Users/test/shop/archive': { kind: 'dir' as const, text: null },
    '/Users/test/shop/sections/h.liquid': { kind: 'file' as const, text: null },
  }
  const ops = [
    { op: 'rm' as const, path: '/Users/test/shop/a.txt' },
    { op: 'rm' as const, path: '/Users/test/shop/dir' },
    { op: 'rm' as const, path: '/Users/test/shop/logo.png' },
    { op: 'rm' as const, path: '/Users/test/shop/big.txt' },
    { op: 'rm' as const, path: '/Users/test/shop/gone' },
    { op: 'rm' as const, path: '/Users/test/shop/never-stat' },
    { op: 'mv' as const, from: '/Users/test/shop/m.txt', to: '/Users/test/shop/n.txt' },
    { op: 'mv' as const, from: '/Users/test/shop/m.txt', to: '/Users/test/shop/archive' },
    { op: 'mv' as const, from: '/Users/test/shop/gone', to: '/Users/test/shop/q' },
    { op: 'mv' as const, from: '/Users/test/shop/sections/h.liquid', to: '/Users/test/shop/sections/h.liquid' },
  ]
  const s = stepsForShell('b', ops, facts, CTX)
  expect(s.map(x => [x.id, x.kind, x.file])).toEqual([
    ['b#1', 'delete', 'a.txt'],
    ['b#2', 'delete', 'dir'],
    ['b#3', 'delete', 'logo.png'],
    ['b#4', 'delete', 'big.txt'],
    ['b#5', 'rename', 'n.txt'],
    ['b#6', 'rename', 'archive/m.txt'],
  ])
  expect(s[0]).toMatchObject({ del: 2, add: 0, note: 'file removed', tool: 'Bash' })
  expect(s[1]!.note).toMatch(/folder removed/)
  expect(s[2]!.note).toMatch(/not text/)
  expect(s[4]).toMatchObject({ from: 'm.txt', note: 'renamed from m.txt' })
  expect(s[5]!.note).toBe('moved from m.txt')
})

// ---------------------------------------------------------------------------------------------
// model.ts and infra.ts
// ---------------------------------------------------------------------------------------------

const turnOf = (n: number, steps: ReplayStep[], over: Partial<ReplayTurn> = {}): ReplayTurn => ({ n, at: Date.UTC(2026, 9, 16, 9, 30), steps, dropped: 0, ...over })

test('the filter: a word matches inside the path, a glob matches the whole name, ! leaves out', async () => {
  const f = parseFilter('Liquid, *.json !locales')
  expect(f.include.length).toBe(2)
  expect(f.exclude.length).toBe(1)
  expect(matches(f, 'sections/hero.liquid')).toBe(true)
  expect(matches(f, 'templates/index.json')).toBe(true)
  expect(matches(f, 'locales/en.json')).toBe(false)
  expect(matches(f, 'assets/app.js')).toBe(false)
  expect(matches(parseFilter('sections/*'), 'theme/sections/a.liquid')).toBe(true)
  expect(matches(parseFilter('sections/*'), 'snippets/a.liquid')).toBe(false)
  expect(matches(parseFilter('a?.js'), 'x/ab.js')).toBe(true)
  expect(matches(parseFilter('a?.js'), 'x/abc.js')).toBe(false)
  expect(matches(parseFilter('!locales'), 'a.js')).toBe(true)
  expect(matches(parseFilter('a.b'), 'axb')).toBe(false)
  expect(matches(parseFilter('(x)+'), '(x)+')).toBe(true)
  expect(parseFilter('  , ! ').include).toEqual([])
  const t = turnOf(1, [step({ file: 'a.js', abs: '/a.js' }), step({ file: 'new.js', from: 'old.liquid', abs: '/new.js', kind: 'rename' }), step({ file: 'b.css', abs: '/b.css' })])
  expect(visibleSteps(t, '').length).toBe(3)
  expect(visibleSteps(t, '*.liquid').map(s => s.file)).toEqual(['new.js'])
  expect(visibleSteps(t, '.js').map(s => s.file)).toEqual(['a.js', 'new.js'])
  expect(visibleSteps(undefined, 'x')).toEqual([])
})

test('totals, groups by file, and the window helpers', async () => {
  const steps = [step({ abs: '/a', file: 'a', add: 2, del: 1 }), step({ abs: '/b', file: 'b', add: 1, del: 0, kind: 'create' }), step({ abs: '/a', file: 'a', add: 3, del: 3 })]
  expect(totals(steps)).toEqual({ edits: 3, files: 2, add: 6, del: 4 })
  const g = groupsOf(steps)
  expect(g.map(x => [x.file, x.first, x.count, x.add, x.del, x.kinds])).toEqual([
    ['a', 0, 2, 5, 4, ['edit']],
    ['b', 1, 1, 1, 0, ['create']],
  ])
  expect(groupOfStep(g, 0)).toBe(0)
  expect(groupOfStep(g, 1)).toBe(1)
  expect(groupOfStep(g, 2)).toBe(1)
  expect(stepsOfGroup(steps, g[0])).toEqual([0, 2])
  expect(stepsOfGroup(steps, undefined)).toEqual([])
  expect(stripRange(5, 2, 10)).toEqual({ from: 0, to: 5 })
  expect(stripRange(60, 0, 10)).toEqual({ from: 0, to: 10 })
  expect(stripRange(60, 30, 10)).toEqual({ from: 25, to: 35 })
  expect(stripRange(60, 59, 10)).toEqual({ from: 50, to: 60 })
  expect(stripRange(60, 5, 0)).toEqual({ from: 4, to: 7 })
  expect(windowChunks([5, 5, 5], 0, 8)).toEqual([{ i: 0, from: 0, to: 5 }, { i: 1, from: 0, to: 3 }])
  expect(windowChunks([5, 5, 5], 7, 5)).toEqual([{ i: 1, from: 2, to: 5 }, { i: 2, from: 0, to: 2 }])
  expect(windowChunks([5], 9, 5)).toEqual([])
  expect(clamp(5, 0, 3)).toBe(3)
  expect(clamp(-1, 0, 3)).toBe(0)
  expect(clamp(5, 0, -4)).toBe(0)
  expect(plural(1, 'edit')).toBe('1 edit')
  expect(plural(2, 'edit')).toBe('2 edits')
  expect(hintText(1)).toBe('▶ Replay: 1 edit (press r)')
  expect(hintText(5)).toBe('▶ Replay: 5 edits (press r)')
})

test('turns kept: the newest, within a size, always at least one', async () => {
  const big = (n: number) => turnOf(n, [step({ hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: [`+${'x'.repeat(50_000)}`] }] })])
  const small = (n: number) => turnOf(n, [step()])
  expect(trimHistory([small(1), small(2), small(3)], 2, 1e9).map(t => t.n)).toEqual([2, 3])
  expect(trimHistory([small(1), small(2)], 0, 1e9).map(t => t.n)).toEqual([2])
  expect(trimHistory([big(1), big(2), big(3)], 10, 120_000).map(t => t.n)).toEqual([2, 3])
  expect(trimHistory([big(1)], 10, 10).map(t => t.n)).toEqual([1])
  expect(trimHistory([], 10, 10)).toEqual([])
  const turns = [small(1), small(2), small(3)]
  expect(turnAt(turns, 0)!.n).toBe(3)
  expect(turnAt(turns, 2)!.n).toBe(1)
  expect(turnAt(turns, 9)!.n).toBe(1)
  expect(turnAt([], 0)).toBeUndefined()
  expect(turnLine(turnOf(4, [step({ add: 2, del: 1 })], { dropped: 3 }), 0)).toMatch(/^last turn \(#4, \d\d:\d\d\): 1 edit in 1 file, \+2 -1, 3 more not kept$/)
  expect(turnLine(turnOf(2, [step(), step({ abs: '/b' })]), 2)).toMatch(/^2 turns ago \(#2, .*\): 2 edits in 2 files/)
  expect(patchForSteps([step({ hunks: diffTexts('a', 'b') }), step({ kind: 'binary' })]).endsWith('\n')).toBe(true)
})

test('/replay words', async () => {
  const c = parseCommand
  expect(c('')).toEqual({ kind: 'open', turn: 0 })
  expect(c('  ')).toEqual({ kind: 'open', turn: 0 })
  expect(c('3')).toEqual({ kind: 'open', turn: 2 })
  expect(c('0')).toMatchObject({ kind: 'bad' })
  expect(c('step')).toEqual({ kind: 'open', turn: 0, mode: 'step' })
  expect(c('file 2')).toEqual({ kind: 'open', turn: 1, mode: 'file' })
  expect(c('files')).toEqual({ kind: 'open', turn: 0, mode: 'overview' })
  expect(c('Overview 4')).toEqual({ kind: 'open', turn: 3, mode: 'overview' })
  expect(c('file x')).toMatchObject({ kind: 'bad' })
  expect(c('step 0')).toMatchObject({ kind: 'bad' })
  expect(c('files y')).toMatchObject({ kind: 'bad' })
  for (const w of ['list', 'turns', 'history']) expect(c(w)).toEqual({ kind: 'list' })
  expect(c('status')).toEqual({ kind: 'status' })
  expect(c('help')).toEqual({ kind: 'help' })
  expect(c('?')).toEqual({ kind: 'help' })
  expect(c('filter *.liquid, sections/')).toEqual({ kind: 'filter', text: '*.liquid, sections/' })
  expect(c('only liquid')).toEqual({ kind: 'filter', text: 'liquid' })
  for (const w of ['filter', 'filter clear', 'filter OFF', 'filter none', 'filter all', 'filter reset']) expect(c(w)).toEqual({ kind: 'filter', text: '' })
  expect(c('split')).toEqual({ kind: 'view', split: true })
  expect(c('side')).toEqual({ kind: 'view', split: true })
  expect(c('unified')).toEqual({ kind: 'view', split: false })
  expect(c('view side-by-side')).toEqual({ kind: 'view', split: true })
  expect(c('view inline')).toEqual({ kind: 'view', split: false })
  expect(c('view')).toMatchObject({ kind: 'bad' })
  expect(c('copy')).toEqual({ kind: 'copy', turn: 0 })
  expect(c('patch 2')).toEqual({ kind: 'copy', turn: 1 })
  expect(c('copy zero')).toMatchObject({ kind: 'bad' })
  expect(c('save')).toEqual({ kind: 'save' })
  expect(c('hide')).toEqual({ kind: 'hide' })
  expect(c('show')).toEqual({ kind: 'show' })
  expect(c('banana')).toMatchObject({ kind: 'bad', text: 'Do not know "banana". Type /replay help.' })
  expect(HELP).toMatch(/n and p step/)
})

test('settings are read safely from userConfig', async () => {
  expect(readSettings(undefined)).toEqual({ keepTurns: 10, collapse: 300, showHint: true, split: false })
  expect(readSettings({ keep_turns: 3, fold_over_lines: 50, show_hint: false, default_view: 'split' })).toEqual({ keepTurns: 3, collapse: 50, showHint: false, split: true })
  expect(readSettings({ keep_turns: 'x', fold_over_lines: -4, default_view: 'diagonal' })).toEqual({ keepTurns: 10, collapse: 300, showHint: true, split: false })
  expect(readSettings({ keep_turns: 500 }).keepTurns).toBe(50)
  expect(readSettings({ keep_turns: 2.9 }).keepTurns).toBe(2)
  expect(readSettings({ fold_over_lines: 0 }).collapse).toBe(0)
  expect(readSettings({ fold_over_lines: 5 }).collapse).toBe(300)
  expect(readSettings('nope').keepTurns).toBe(10)
})

test('the switch file: off, hidden, broken, arrays; hidden is set without losing other lines', async () => {
  expect(parseFlags('{"replay-theater": false}')).toEqual({ off: true, hidden: false })
  expect(parseFlags('{"replay-theater": true}')).toEqual({ off: false, hidden: false })
  expect(parseFlags('{"replay-theater:hidden": true, "x": false}')).toEqual({ off: false, hidden: true })
  expect(parseFlags('{"replay-theater": "no"}')).toEqual({ off: false, hidden: false })
  expect(parseFlags('{ broken')).toEqual({ off: false, hidden: false })
  expect(parseFlags('[false]')).toEqual({ off: false, hidden: false })
  expect(parseFlags('null')).toEqual({ off: false, hidden: false })
  expect(parseFlags('')).toEqual({ off: false, hidden: false })
  expect(JSON.parse(withHidden('{"a": false}', true))).toEqual({ a: false, 'replay-theater:hidden': true })
  expect(JSON.parse(withHidden(undefined, true))).toEqual({ 'replay-theater:hidden': true })
  expect(JSON.parse(withHidden('{"a": 1, "replay-theater:hidden": true}', false))).toEqual({ a: 1 })
  expect(() => withHidden('[1]', true)).toThrow()
  expect(() => withHidden('{ broken', true)).toThrow()
  expect(withHidden('{}', true).endsWith('\n')).toBe(true)
})

test('log lines are short, on one line, and the log keeps its newest 300', async () => {
  const line = logLine(Date.UTC(2026, 9, 16, 9, 30), 'record', `a\nb ${'x'.repeat(400)}`)
  expect(line.startsWith('2026-10-16T09:30:00.000Z record: a b ')).toBe(true)
  expect(line.length).toBeLessThan(230)
  expect(logLine(0, 'off', '')).toMatch(/Z off$/)
  expect(errText(new Error('a\n  b'))).toBe('a b')
  expect(errText('plain')).toBe('plain')
  expect(errText(new Error('x'.repeat(500))).length).toBe(160)
  const old = Array.from({ length: 450 }, (_, i) => `l${i}`).join('\n')
  const out = appendLog(old, 'new').split('\n').filter(Boolean)
  expect(out.length).toBe(300)
  expect(out[299]).toBe('new')
  expect(out[0]).toBe('l151')
  expect(openRequestPath('/h', 's1')).toBe('/h/.claude/claude-mods/.open-replay-theater-s1')
  expect(patchPath('/h')).toBe('/h/.claude/claude-mods/replay-theater/last.patch')
})
