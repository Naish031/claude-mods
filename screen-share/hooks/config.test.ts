import { expect, test } from 'claude-code/testing'

import { buildRules, onKinds, parseList, parseWordFile, readOverrides, readSettings, usernameOf, wordFileText, wordsFromArgs } from './config'
import { BAR } from './mask'

test('readSettings: defaults, valid values, and invalid values falling back', () => {
  const d = readSettings({})
  expect(d.style).toBe('bar')
  expect(d.names).toBe('smart')
  expect(d.glyph).toBe(BAR)
  expect(d.peekSeconds).toBe(10)
  expect(d.fade).toBe(true)
  expect(d.hideSuggestions).toBe(true)
  expect(d.maskPanels).toBe(true)
  expect(d.maskUsername).toBe(true)
  expect(Object.values(d.kinds).every(Boolean)).toBe(true)
  expect(d.deny).toEqual([])

  const s = readSettings({ style: 'label', names: 'context', bar_glyph: '█', peek_seconds: 30, fade_in: false, mask_emails: false, mask_paths: false, always_mask: 'Acme, Project X\nGlobex', never_mask: 'Priya Sharma; @me.com', hide_suggestions: false, mask_panels: false })
  expect(s.style).toBe('label')
  expect(s.names).toBe('context')
  expect(s.glyph).toBe('█')
  expect(s.peekSeconds).toBe(30)
  expect(s.fade).toBe(false)
  expect(s.kinds.email).toBe(false)
  expect(s.kinds.path).toBe(false)
  expect(s.kinds.phone).toBe(true)
  expect(s.deny).toEqual(['Acme', 'Project X', 'Globex'])
  expect(s.allow).toEqual(['Priya Sharma', '@me.com'])
  expect(s.hideSuggestions).toBe(false)
  expect(s.maskPanels).toBe(false)

  const bad = readSettings({ style: 'neon', names: 'always', bar_glyph: 'Z', peek_seconds: 0, always_mask: 5 as never })
  expect(bad.style).toBe('bar')
  expect(bad.names).toBe('smart')
  expect(bad.glyph).toBe(BAR)
  expect(bad.peekSeconds).toBe(10)
  expect(bad.deny).toEqual([])
  expect(readSettings({ peek_seconds: 99999 }).peekSeconds, 'a peek is capped').toBe(120)
})

test('parseList: commas, semicolons, bars and lines; blanks, one letter words and repeats are dropped', () => {
  expect(parseList('a1, b2;c3|d4\ne5\r\nf6')).toEqual(['a1', 'b2', 'c3', 'd4', 'e5', 'f6'])
  expect(parseList('  ,, ;; x ')).toEqual([])
  expect(parseList('Acme, acme, ACME')).toEqual(['Acme'])
  expect(parseList(undefined)).toEqual([])
  expect(parseList('x'.repeat(200))).toEqual([])
})

test('wordsFromArgs: one phrase with spaces stays one phrase, commas split, quotes go', () => {
  expect(wordsFromArgs('Acme Corp')).toEqual(['Acme Corp'])
  expect(wordsFromArgs('"Acme Corp", Zed Zebra')).toEqual(['Acme Corp', 'Zed Zebra'])
  expect(wordsFromArgs('')).toEqual([])
})

test('overrides: only values of the right shape are taken from the store', () => {
  expect(readOverrides({ style: 'partial', names: 'off', kinds: { email: false, nonsense: true, phone: 'no' } })).toEqual({ style: 'partial', names: 'off', kinds: { email: false } })
  expect(readOverrides({ style: 7, names: 'x', kinds: 'all' })).toEqual({})
  expect(readOverrides({})).toEqual({})
})

test('buildRules: the config menu, the words file and the stored overrides, later ones winning', () => {
  const base = readSettings({ style: 'bar', names: 'smart', always_mask: 'Acme', never_mask: 'Zed' })
  const file = parseWordFile(JSON.stringify({ mask: ['Globex', 'acme'], allow: ['Priya'] }))
  const r = buildRules(base, { style: 'label', kinds: { phone: false } }, file, '/Users/janedoe')
  expect(r.style, 'override beats menu').toBe('label')
  expect(r.kinds.phone).toBe(false)
  expect(r.kinds.email).toBe(true)
  expect(r.deny, 'menu + file + the account name, no repeats').toEqual(['Acme', 'Globex', 'janedoe'])
  expect(r.allow).toEqual(['Zed', 'Priya'])
  expect(r.kinds.custom, 'the always-mask kind is on while there is a word').toBe(true)
  const empty = buildRules(readSettings({ mask_username: false }), {}, { mask: [], allow: [] }, '/Users/janedoe')
  expect(empty.deny).toEqual([])
  expect(empty.kinds.custom).toBe(false)
  expect(buildRules(base, {}, file, '/Users/test').deny, 'an ordinary account name is not used').toEqual(['Acme', 'Globex'])
})

test('words file: parse, write back, and a broken file is an empty one', () => {
  const f = parseWordFile('{"mask":["Acme"," ","Acme","x"],"allow":"no"}')
  expect(f).toEqual({ mask: ['Acme'], allow: [] })
  expect(parseWordFile(wordFileText({ mask: ['A1', 'B2'], allow: ['C3'] }))).toEqual({ mask: ['A1', 'B2'], allow: ['C3'] })
  expect(parseWordFile('{ not json')).toEqual({ mask: [], allow: [] })
  expect(parseWordFile('')).toEqual({ mask: [], allow: [] })
  expect(wordFileText({ mask: [], allow: [] }).endsWith('\n')).toBe(true)
})

test('onKinds names the kinds that are on; usernameOf skips ordinary words', () => {
  expect(onKinds({ ...readSettings({ mask_emails: false }).kinds })).not.toContain('email')
  expect(onKinds(readSettings({}).kinds)).toContain('amount')
  expect(usernameOf('C:\\Users\\Alexandra')).toBe('Alexandra')
  expect(usernameOf('/home/admin')).toBeUndefined()
})
