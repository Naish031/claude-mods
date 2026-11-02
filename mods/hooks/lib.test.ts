import { expect, test } from 'claude-code/testing'

import {
  applyChanges,
  blockReason,
  buildInfo,
  commandsIn,
  cut,
  expandHome,
  groupOf,
  matchesFilter,
  parseInstalled,
  parsePane,
  parseSwitches,
  safeName,
  shortWhat,
  sortRows,
  splitPaths,
  stripComments,
  undoChanges,
} from './lib'

const plugin = (o: object = {}) => JSON.stringify({ name: 'demo', version: '1.2.3', description: 'Does a thing for you every day. And more.', ...o })
const hooks = '{"modules":["./register.tsx"]}'

test('parseSwitches: missing, empty, object, and anything else', () => {
  expect(parseSwitches(null).kind).toBe('missing')
  expect(parseSwitches('  \n').kind).toBe('missing')
  expect(parseSwitches('{"a": false}')).toEqual({ kind: 'ok', json: { a: false } })
  expect(parseSwitches('{ not json').kind).toBe('bad')
  expect(parseSwitches('[1,2]').kind).toBe('bad')
  expect(parseSwitches('null').kind).toBe('bad')
  expect(parseSwitches('"text"').kind).toBe('bad')
  expect(parseSwitches('{').json).toEqual({})
})

test('applyChanges keeps unknown keys, records before and after, and deletes on undefined', () => {
  const start = { keep: { deep: [1, 2] }, a: false, 'b:hidden': true }
  const out = applyChanges(start, [
    { key: 'a', value: undefined },
    { key: 'c', value: false },
  ])
  expect(out.json).toEqual({ keep: { deep: [1, 2] }, 'b:hidden': true, c: false })
  expect(out.before).toEqual({ a: false, c: undefined })
  expect(out.after).toEqual({ a: undefined, c: false })
  expect(start, 'the input is not changed').toEqual({ keep: { deep: [1, 2] }, a: false, 'b:hidden': true })
})

test('undoChanges restores a key only when nobody changed it since', () => {
  const entry = { before: { a: undefined, b: false }, after: { a: false, b: undefined } }
  expect(undoChanges({ a: false }, entry)).toEqual({ changes: [{ key: 'a', value: undefined }, { key: 'b', value: false }], skipped: 0 })
  const moved = undoChanges({ a: true }, entry)
  expect(moved.skipped, 'a was changed by someone else').toBe(1)
  expect(moved.changes).toEqual([{ key: 'b', value: false }])
})

test('safeName refuses names that are odd as keys', () => {
  expect(safeName('cache-clock')).toBe(true)
  expect(safeName('a.b_c-1')).toBe(true)
  expect(safeName('__proto__')).toBe(false)
  expect(safeName('')).toBe(false)
  expect(safeName('has space')).toBe(false)
  expect(safeName('x'.repeat(65))).toBe(false)
})

test('blockReason: only a user-tier mod the person blocked, never this one, never while Mods is off', () => {
  const self = 'mods'
  expect(blockReason({ name: 'a', tier: 'user' }, { 'a:block': true }, self)).toContain('Blocked in the Mods pane')
  expect(blockReason({ name: 'a', tier: 'user' }, {}, self), 'not blocked').toBeNull()
  expect(blockReason({ name: 'a', tier: 'user' }, { a: false }, self), 'an off switch is not a block').toBeNull()
  expect(blockReason({ name: 'a', tier: 'prepend' }, { 'a:block': true }, self), 'managed tiers are never refused').toBeNull()
  expect(blockReason({ name: 'a', tier: 'builtin' }, { 'a:block': true }, self)).toBeNull()
  expect(blockReason({ name: 'mods', tier: 'user' }, { 'mods:block': true }, self), 'never itself').toBeNull()
  expect(blockReason({ name: 'a', tier: 'user' }, { 'a:block': true, mods: false }, self), 'Mods off means no blocking').toBeNull()
  expect(blockReason({ name: 'a', tier: 'user' }, { 'a:block': 'yes' }, self), 'only true counts').toBeNull()
  expect(blockReason({ name: '__proto__', tier: 'user' }, { '__proto__:block': true }, self), 'odd names are left alone').toBeNull()
})

test('buildInfo: a folder is a mod only with plugin.json and hooks.json "modules"', () => {
  expect(buildInfo('x', '', hooks, '', '')).toBeNull()
  expect(buildInfo('x', plugin(), '{"hooks":{}}', '', '')).toBeNull()
  expect(buildInfo('x', plugin(), 'not json', '', '')).toBeNull()
  const info = buildInfo('folder-name', plugin(), hooks, '', '')
  expect(info?.name).toBe('demo')
  expect(info?.title).toBe('Demo')
  expect(info?.version).toBe('1.2.3')
  expect(info?.what).toBe('Does a thing for you every day.')
  expect(buildInfo('folder-name', '{"version":"1"}', hooks, '', '')?.name, 'no name: the folder name').toBe('folder-name')
})

test('buildInfo: switch, hide, commands and pane are read from the code', () => {
  const code = [
    "// readSwitch('switches.json') in a comment does not count",
    "const k = `${NAME}:hidden`",
    "await $.command.register({ name: 'demo', description: 'x' })",
    "await $.command.register({\n  name: 'second',\n})",
    "await $.fs.write(`${m}/.open-demo-${sid}`, '')",
  ].join('\n')
  const quiet = buildInfo('d', plugin(), hooks, '', code)
  expect(quiet?.switchKind, 'only a comment mentions the file').toBe('none')
  expect(quiet?.hide).toBe(true)
  expect(quiet?.commands).toEqual(['demo', 'second'])
  expect(quiet?.opener, 'no Pane drawn: it only polls for requests').toBe('request')
  expect(quiet?.hasPane).toBe(false)

  const full = buildInfo('d', plugin(), hooks, '', `${code}\nconst f = 'claude-mods/switches.json'\nawait $.ui.open({ id: 'p' })\non('ui.render', { component: 'Pane', requestId: 'p' }, x)`)
  expect(full?.switchKind).toBe('file')
  expect(full?.hasPane).toBe(true)
  expect(full?.pane, 'the first command opens the pane').toEqual({ command: 'demo', args: '' })
  expect(full?.opener).toBe('command')
})

test('buildInfo: mod.json metadata beats the code, plugin.json fields are read too', () => {
  const code = "const f = 'switches.json'\nawait $.command.register({ name: 'other' })"
  const meta = buildInfo('d', plugin(), hooks, JSON.stringify({ pane: '/helpers open', hide: true, switch: true, title: 'Fancy Name' }), code)
  expect(meta?.pane).toEqual({ command: 'helpers', args: 'open' })
  expect(meta?.hasPane).toBe(true)
  expect(meta?.hide).toBe(true)
  expect(meta?.title).toBe('Fancy Name')

  const off = buildInfo('d', plugin(), hooks, JSON.stringify({ switch: false }), code)
  expect(off?.switchKind, 'switch:false says it has no switch').toBe('none')

  const inPlugin = buildInfo('d', plugin({ pane: 'p1', title: 'T1' }), hooks, '', '')
  expect(inPlugin?.pane?.command).toBe('p1')
  expect(inPlugin?.title).toBe('T1')

  const wins = buildInfo('d', plugin({ pane: 'p1' }), hooks, JSON.stringify({ pane: 'p2' }), '')
  expect(wins?.pane?.command, 'mod.json wins').toBe('p2')

  const none = buildInfo('d', plugin(), hooks, JSON.stringify({ pane: false }), "await $.ui.open({})\ncomponent: 'Pane'\ncommand.register({ name: 'x' })")
  expect(none?.pane, 'pane:false means no pane').toBeNull()
  expect(none?.hasPane).toBe(false)

  const bad = buildInfo('d', plugin(), hooks, JSON.stringify({ pane: 'a/b', hide: 'yes' }), '')
  expect(bad?.pane, 'a pane that is not a command name is ignored').toBeNull()
  expect(bad?.hide, 'a hide that is not a boolean is ignored').toBe(false)
})

test('parsePane', () => {
  expect(parsePane('helpers')).toEqual({ command: 'helpers', args: '' })
  expect(parsePane('/helpers  show it ')).toEqual({ command: 'helpers', args: 'show it' })
  expect(parsePane(false)).toBeNull()
  expect(parsePane('')).toBeNull()
  expect(parsePane(5)).toBeUndefined()
  expect(parsePane('a/b')).toBeUndefined()
})

test('stripComments and commandsIn', () => {
  expect(stripComments("a\n  // gone\n/* block\nspans */b")).not.toContain('gone')
  expect(stripComments('x\n/* a\nb */y')).toContain('x')
  expect(commandsIn("command.register({ name: 'a-b' }) command.register( {name:\"c\"} ) command.register({ name: 'a-b' })")).toEqual(['a-b', 'c'])
})

test('groupOf, sortRows, matchesFilter', () => {
  expect(groupOf('/Users/t/.claude/dev-mods/s1/x', 's1')).toBe('chat')
  expect(groupOf('/Users/t/.claude/dev-mods/s2/x', 's1')).toBe('other')
  expect(groupOf('/Users/t/.claude/plugins/cache/m/x/1', 's1')).toBe('market')
  expect(groupOf('/Users/t/Documents/x', 's1')).toBe('yours')
  const sorted = sortRows([
    { group: 'other' as const, title: 'A' },
    { group: 'yours' as const, title: 'Z' },
    { group: 'yours' as const, title: 'B' },
    { group: 'market' as const, title: 'M' },
    { group: 'chat' as const, title: 'C' },
  ])
  expect(sorted.map(r => r.title)).toEqual(['B', 'Z', 'M', 'C', 'A'])
  const row = { name: 'helper-desk', title: 'Helper Desk', what: 'Task bar', commands: ['helpers'] }
  expect(matchesFilter(row, '')).toBe(true)
  expect(matchesFilter(row, 'DESK bar')).toBe(true)
  expect(matchesFilter(row, '/helpers'.slice(1))).toBe(true)
  expect(matchesFilter(row, 'nothing')).toBe(false)
})

test('paths: expandHome, splitPaths, cut, shortWhat', () => {
  expect(expandHome('~', '/Users/t')).toBe('/Users/t')
  expect(expandHome('~/x/', '/Users/t')).toBe('/Users/t/x')
  expect(expandHome('/opt/y//', '/Users/t')).toBe('/opt/y')
  expect(splitPaths('~/a::/b/:~/a', '/Users/t')).toEqual(['/Users/t/a', '/b'])
  expect(splitPaths(undefined, '/Users/t')).toEqual([])
  expect(cut('abcdef', 4)).toBe('abc…')
  expect(cut('abc', 0)).toBe('')
  expect(shortWhat('First sentence is long enough. Second one.')).toBe('First sentence is long enough.')
  expect(shortWhat('x'.repeat(300)).length).toBeLessThanOrEqual(110)
})

test('parseInstalled reads both file shapes and skips junk', () => {
  const v2 = JSON.stringify({ version: 2, plugins: { 'a@m': [{ scope: 'user', installPath: '/p/a/1/', version: '1' }], 'b@m': [{ nope: 1 }], junk: [{ installPath: '/x' }] } })
  expect(parseInstalled(v2)).toEqual([{ key: 'a@m', name: 'a', dir: '/p/a/1', version: '1' }])
  const v1 = JSON.stringify({ plugins: { 'c@m': { installPath: '/p/c', version: '2' } } })
  expect(parseInstalled(v1)[0]?.name).toBe('c')
  expect(parseInstalled('not json')).toEqual([])
})
