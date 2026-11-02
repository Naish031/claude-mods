import { expect, test } from 'claude-code/testing'

import { usernameOf } from './config'
import { BAR, DEFAULT_RULES, compile, draw, findSpans, hiddenRow, keyKind, leaks, maskDeep, maskText, redact, type Rules } from './mask'

// The masker as pure functions: every detector, with positives, negatives and the tricky ones between.

const rules = (over: Partial<Rules> = {}): Rules => ({ ...DEFAULT_RULES, ...over, kinds: { ...DEFAULT_RULES.kinds, ...(over.kinds ?? {}) } })
// Fake keys, built in pieces so no scanner mistakes this file for a leak.
const AWS = ['AKIA', 'IOSFODNN7EXAMPLE'].join('')
const GHP = ['ghp', '_abcdefghijklmnopqrstuvwxyz0123456789'].join('')
const SHP = ['shp', 'at_0123456789abcdef0123456789abcdef'].join('')
const C = compile(rules())
/** The text with each hidden span replaced by its kind in brackets. */
const tag = (s: string, c = C) => redact(s, c, (_hit, kind) => `[${kind}]`)

function table(cases: Array<[string, string]>, c = C) {
  for (const [input, want] of cases) expect(tag(input, c), input).toBe(want)
}

test('emails: shapes, separators, unicode, urls, and what is not an email', () => {
  table([
    ['Mail jane.doe+leads@acme.co.uk today', 'Mail [email] today'],
    ['Email: JANE@ACME.COM, a.b-c_d+tag@sub.domain.co.uk; "x@y.io"; <z@y.io>; (q@y.io)', 'Email: [email], [email]; "[email]"; <[email]>; ([email])'],
    ['The email is jane@acme.com.', 'The email is [email].'],
    ['José@café.com und 王@例え.jp', '[email] und [email]'],
    ["o'brien@acme.ie", '[email]'],
    // inside a link the email still goes, the rest of the link stays
    ['mailto:jane@acme.com?subject=Hi', 'mailto:[email]?subject=Hi'],
    ['https://example.com/?email=jane@acme.com&x=1', 'https://example.com/?email=[email]&x=1'],
    ['https://u:secretpass@host.com/x', 'https://u:[secret]@host.com/x'],
    // not emails
    ['react@18.3.1, @anthropic-ai/sdk, git@github.com:me/repo', 'react@18.3.1, @anthropic-ai/sdk, git@github.com:me/repo'],
    ['foo@bar, @user, a@b, version@1.2, user@localhost, scoped @types/node@18.0.0', 'foo@bar, @user, a@b, version@1.2, user@localhost, scoped @types/node@18.0.0'],
    ['icon@2x.png and logo@3x.webp', 'icon@2x.png and logo@3x.webp'],
    ['dev@x.png.com', '[email]'],
    ['decorator @Component and @media (max-width: 600px)', 'decorator @Component and @media (max-width: 600px)'],
  ])
})

test('phones: international and national formats', () => {
  table([
    ['UK +44 7700 900123, US +1 (415) 555-0132', 'UK [phone], US [phone]'],
    ['US 415-555-0132, landline 020 7946 0958, mobile 07700 900123', 'US [phone], landline [phone], mobile [phone]'],
    ['Phone +1-415-555-0132 or (415) 555-0132 or 415.555.0132 or 1 415 555 0132', 'Phone [phone] or [phone] or [phone] or [phone]'],
    ['India 98765 43210 and 9876543210 and +919876543210', 'India [phone] and [phone] and [phone]'],
    ['+49 30 12345678, +33 1 23 45 67 89, +61 4 1234 5678, +81 3-1234-5678, +55 11 91234-5678', '[phone], [phone], [phone], [phone], [phone]'],
    ['tel:+447700900123 and WhatsApp 447700900123 and mobile: 07700 900 123', 'tel:[phone] and WhatsApp [phone] and mobile: [phone]'],
    ['French 06 12 34 56 78 here', 'French [phone] here'],
    ['Call +44 7700 900123 in 2026', 'Call [phone] in 2026'],
    // a bare number is a phone only after a word that says so
    ['phone: 5551234567 and call 4155550132', 'phone: [phone] and call [phone]'],
  ])
})

test('phones: what is not a phone', () => {
  table([
    ['In 2026 we used 182k tokens on v2.1.295', 'In 2026 we used 182k tokens on v2.1.295'],
    ['Dates 2026-10-15, 15.10.2026, 10/15/2026 at 14:30:00', 'Dates 2026-10-15, 15.10.2026, 10/15/2026 at 14:30:00'],
    ['Open /Users/test/clips/9876543210/a.mp4 and ~/x/415-555-0132.md', 'Open /Users/[path]/clips/9876543210/a.mp4 and ~/x/415-555-0132.md'],
    ['See https://site.com/u/9876543210/x?n=447700900123 now', 'See https://site.com/u/9876543210/x?n=447700900123 now'],
    ['Order 17600000001234, ts 1760000000000, window 1,000,000', 'Order 17600000001234, ts 1760000000000, window 1,000,000'],
    ['Years 2024 2025 2026, range 2019-2026, IP 192.168.100.1', 'Years 2024 2025 2026, range 2019-2026, IP 192.168.100.1'],
    ['Call +44 7700 900123 in 2026, +1234 -567 lines, 50% off', 'Call [phone] in 2026, +1234 -567 lines, 50% off'],
    ['SKU 123-456-789, build 2026-11-01, run 20261101, id 12345678, port 8080, pid 47213', 'SKU 123-456-789, build 2026-11-01, run 20261101, id 12345678, port 8080, pid 47213'],
    ['Version 10.15.7.1 at 192.168.0.1:8080 and 10.0.0.255', 'Version 10.15.7.1 at 192.168.0.1:8080 and 10.0.0.255'],
    ['size 1,234,567 bytes; 3.14159265; 1e10; 0.5', 'size 1,234,567 bytes; 3.14159265; 1e10; 0.5'],
    ['Lat 51.5074, Lon -0.1278; 12:30:45; 2026-11-01T12:30:45Z', 'Lat 51.5074, Lon -0.1278; 12:30:45; 2026-11-01T12:30:45Z'],
    ['order #1234567890 and ref ABC1234567890 and 5551234567 alone', 'order #1234567890 and ref ABC1234567890 and 5551234567 alone'],
    ['10 20 30 40 50 and 1 2 3 4 5 6 7 8 9', '10 20 30 40 50 and 1 2 3 4 5 6 7 8 9'],
    ['color #ff00aa, #1234567890, 0x7700900123', 'color #ff00aa, #1234567890, 0x7700900123'],
  ])
})

test('amounts: signs, codes, words, scales and number formats', () => {
  table([
    ['Paid $4,250.00, £900, €12k and ₹4,500', 'Paid [amount], [amount], [amount] and [amount]'],
    ['Budget USD 300, or 1,200 dollars, or Rs. 4,500', 'Budget [amount], or [amount], or [amount]'],
    ['$1.2M, $20bn, ₹1.2 lakh, ₹5 crore, 1.234,56 € and 1.234,56€, CHF 1\'234.50, £1,000,000', '[amount], [amount], [amount], [amount], [amount] and [amount], [amount], [amount]'],
    ['US$300, R$ 50, A$12.50, HK$1,000, \\$500 escaped', '[amount], [amount], [amount], [amount], [amount] escaped'],
    ['USD300 EUR 12.5 AUD 1,200.00 CAD 50', '[amount] [amount] [amount] [amount]'],
    ['12 dollars, 5 euros, 10 bucks, 100 USD, 3 million dollars, 50 kr, 20zł', '[amount], [amount], [amount], [amount], [amount], [amount], [amount]'],
    ['costs $5.99/mo or $5/month and $0.99', 'costs [amount]/mo or [amount]/month and [amount]'],
    ['Total: 1,200.00 and balance of 25000.', 'Total: [amount] and balance of [amount].'],
    ['{"total_price": "129.00", "subtotal": 1200, "count": 3, "tax": 12.50}', '{"total_price": "[amount]", "subtotal": [amount], "count": 3, "tax": [amount]}'],
    ['Cost (USD): 45, "currency": "USD", "amount": 4500', 'Cost (USD): 45, "currency": "USD", "amount": [amount]'],
  ])
})

test('amounts: plain numbers, prices versus counts, and shell arguments', () => {
  table([
    ['182k tokens, 12 files, 3 items, 100% done, 5 m of rope, 2.5 GB, 300 ms', '182k tokens, 12 files, 3 items, 100% done, 5 m of rope, 2.5 GB, 300 ms'],
    ['Price tiers: Basic 9, Pro 29; total: 3 files; amount of 5 things', 'Price tiers: Basic 9, Pro 29; total: 3 files; amount of 5 things'],
    ['Total: 1,234 tokens and total: 12 orders and tax: 12', 'Total: 1,234 tokens and total: 12 orders and tax: 12'],
    ['echo $1 and $HOME and ${x}', 'echo $1 and $HOME and ${x}'],
    ['shell: for f in *; do echo "$1" "$2"; awk \'{print $1}\' x; done', 'shell: for f in *; do echo "$1" "$2"; awk \'{print $1}\' x; done'],
    ['costs $5 today', 'costs [amount] today'],
    ['It costs 5 dollars and 5 m of rope', 'It costs [amount] and 5 m of rope'],
    ['v2.1.309, 2026, 12,000 lines of code', 'v2.1.309, 2026, 12,000 lines of code'],
  ])
})

test('secrets: known token shapes, keys with values, and what stays', () => {
  table([
    [`key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 and ${GHP} ok`, 'key [secret] and [secret] ok'],
    ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456', 'Authorization: Bearer [secret]'],
    [`AWS ${AWS} and secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`, 'AWS [secret] and secret [secret]'],
    [`export API_KEY=abc123def456ghi789 and SHOPIFY_TOKEN="${SHP}"`, 'export API_KEY=[secret] and SHOPIFY_TOKEN="[secret]"'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', '[secret]'],
    ['-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----', '[secret]'],
    ['password: hunter2hunter2 and token=abcd1234efgh5678', 'password: [secret] and token=[secret]'],
    ['https://x.com/cb?api_key=abcdef123456&x=1', 'https://x.com/cb?api_key=[secret]&x=1'],
    // placeholders and counts are not secrets
    ['token: ****** password: <redacted> secret=${SECRET} password: your-password', 'token: ****** password: <redacted> secret=${SECRET} password: your-password'],
    ['max_tokens=4000 tokens: 182000 token_count: 12345678', 'max_tokens=4000 tokens: 182000 token_count: 12345678'],
    ['git sha 9fceb02d0ae598e95dc970b74767f19372d61af8 stays', 'git sha 9fceb02d0ae598e95dc970b74767f19372d61af8 stays'],
  ])
})

test('long digit strings: cards that pass their checksum, IBANs, IDs; order numbers and timestamps stay', () => {
  table([
    ['4242 4242 4242 4242, 4242-4242-4242-4242, 5555555555554444, 378282246310005, 6011111111111117', '[number], [number], [number], [number], [number]'],
    ['1234 5678 9012 3456 is not a card; 4111 1111 1111 1112 neither; epoch 1760000000000; 1234567890123456', '1234 5678 9012 3456 is not a card; 4111 1111 1111 1112 neither; epoch 1760000000000; 1234567890123456'],
    ['IBAN DE89 3704 0044 0532 0130 00 and GB82WEST12345698765432, not XX00 1234', 'IBAN [number] and [number], not XX00 1234'],
    ['SSN 123-45-6789 and 123-45-678', 'SSN [number] and 123-45-678'],
    ['Aadhaar 2345 6789 0123; NINO AB 12 34 56 C', 'Aadhaar [number]; NINO [number]'],
    ['Order 17600000001234, invoice 100200300400, tracking 9400111899223197428490', 'Order 17600000001234, invoice 100200300400, tracking 9400111899223197428490'],
  ])
})

test('paths and addresses', () => {
  table([
    ['/home/alice/projects and /root/x and /Users/Shared/y and C:\\Users\\Bob\\Desktop', '/home/[path]/projects and /root/x and /Users/Shared/y and C:\\Users\\[path]\\Desktop'],
    ['221B Baker Street, London NW1 6XE; 1600 Pennsylvania Avenue; Springfield, IL 62704', '[address], London [address]; [address]; [address]'],
    ['3 files in 12 High Street today', '3 files in [address] today'],
    ['The 2 Street Fighter games', 'The 2 Street Fighter games'],
  ])
})

test('names: said outright, next to an email, in a labelled line, in JSON', () => {
  table([
    ['Jane Doe <jane@x.com>', '[name] <[email]>'],
    ['"Jane Doe" <jane@x.com>', '"[name]" <[email]>'],
    ['**From:** Jane Sample <jane@example.com>', '**From:** [name] <[email]>'],
    ['To: Jane Doe, Bob Smith and Ravi Kumar', 'To: [name], [name] and [name]'],
    ['Contact Bob Smith (bob@acme.co.uk) today', 'Contact [name] ([email]) today'],
    ['| Ravi Kumar | ravi@x.in | ₹4,500 |', '| [name] | [email] | [amount] |'],
    ['jane@x.com (Jane Doe)', '[email] ([name])'],
    ['{"name": "Jane Doe", "email": "jane@x.com"}', '{"name": "[name]", "email": "[email]"}'],
    ['"full_name": "José Álvarez"', '"full_name": "[name]"'],
    ['Author: Jane Doe <jane@x.com>\nDate: Mon Oct 5', 'Author: [name] <[email]>\nDate: Mon Oct 5'],
    ['Hi Jane, the API Key is ready.', 'Hi [name], the API Key is ready.'],
    ['Thanks, Priya!\nBest regards,\nPriya Sharma', 'Thanks, [name]!\nBest regards,\n[name]'],
    ['Dr. Smith and Mrs Johnson and Prof Alan Turing', 'Dr. [name] and Mrs [name] and Prof [name]'],
    ['my name is Ravi Kumar and call me Bob', 'my name is [name] and call me [name]'],
    ['Assigned to Rahul Mehta. Reported by: Sarah Connor', 'Assigned to [name]. Reported by: [name]'],
    ['First name: Ravi; Last name: Kumar', 'First name: [name]; Last name: [name]'],
    ['"first_name": "Ravi", "last_name": "Kumar", "email": "r@x.in", "phone": "555-1234", "address1": "12 High St", "zip": "90210"', '"first_name": "[name]", "last_name": "[name]", "email": "[email]", "phone": "[phone]", "address1": "[address]", "zip": "[address]"'],
    ['Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>', 'Co-Authored-By: Claude Sonnet 5.5 <[email]>'],
  ])
})

test('names: ordinary capitalised words are not names', () => {
  table([
    ['{"name": "screen-share", "version": "0.1.0"}', '{"name": "screen-share", "version": "0.1.0"}'],
    ['Hi there, the API Key is ready. Note: Run This Now', 'Hi there, the API Key is ready. Note: Run This Now'],
    ['Customer Success: help@x.com', 'Customer Success: [email]'],
    ['Hello World and Hi Team and Dear Customer and Hello Everyone, Hi All, Dear Sir', 'Hello World and Hi Team and Dear Customer and Hello Everyone, Hi All, Dear Sir'],
    ['Name: Open Source Contributions\nOwner: Platform Team', 'Name: Open Source Contributions\nOwner: Platform Team'],
    ['Visual Studio Code, Amazon Web Services, Google Cloud, New York, San Francisco, Open AI', 'Visual Studio Code, Amazon Web Services, Google Cloud, New York, San Francisco, Open AI'],
    ['Product color: Forest Green; size: Dark Blue; Mason Jar; Olive Branch; Rose Gold', 'Product color: Forest Green; size: Dark Blue; Mason Jar; Olive Branch; Rose Gold'],
    ['Claude Code and Shopify Admin on GitHub Actions', 'Claude Code and Shopify Admin on GitHub Actions'],
    ['Sam\'s Club and Jack Daniel\'s', 'Sam\'s Club and Jack Daniel\'s'],
    // a field name with a type or a template slot after it is code, not data
    ['address: string; email: string; phone: number; password: string; zip: {{zip}}', 'address: string; email: string; phone: number; password: string; zip: {{zip}}'],
  ])
})

test('names: smart mode reads two words that look like a first and last name, context mode does not', () => {
  table([
    ['Sarah Connor met Sam Altman and Alex Johnson.', '[name] met [name] and [name].'],
    ['Maria Garcia, Mohammed Ali, Wei Zhang, Olga Ivanova', '[name], [name], [name], [name]'],
    ['Ask Mark Johnson, then Will Smith', 'Ask [name], then [name]'],
    ['Sarah alone, and Smith alone, and Mark Twain', 'Sarah alone, and Smith alone, and Mark Twain'],
  ])
  const context = compile(rules({ names: 'context' }))
  table([['Sarah Connor met Sam Altman', 'Sarah Connor met Sam Altman'], ['To: Sarah Connor', 'To: [name]']], context)
  const off = compile(rules({ names: 'off' }))
  table([['To: Sarah Connor <s@x.com>', 'To: Sarah Connor <[email]>']], off)
})

test('always-mask words: any case, separators between words, whole words only, deny beats the rest', () => {
  const c = compile(rules({ deny: ['Acme Corp', 'Globex', 'jane@private.org', 'Project X'] }))
  table(
    [
      ['Acme Corp, acme-corp, ACME_CORP and acme.corp', '[custom], [custom], [custom] and [custom]'],
      ['Globex and globex-prod but not Globexes', '[custom] and [custom]-prod but not Globexes'],
      ['mail jane@private.org now', 'mail [custom] now'],
      ['Project X is live', '[custom] is live'],
      ['A project xylophone', 'A project xylophone'],
    ],
    c,
  )
  // a word that is listed twice, as allow and as deny, is hidden
  const both = compile(rules({ deny: ['Globex'], allow: ['Globex'] }))
  expect(tag('Globex', both)).toBe('[custom]')
  // an empty list costs nothing and hides nothing
  expect(compile(rules({ deny: [] })).denyRe).toBeNull()
  // regex characters in a word are plain text
  const odd = compile(rules({ deny: ['a.b*c(d', '[x]'] }))
  expect(tag('see a.b*c(d and [x] and aXb', odd)).toBe('see [custom] and [custom] and aXb')
})

test('never-mask words: a name, a phrase, a number, a whole email domain', () => {
  const c = compile(rules({ allow: ['Priya Sharma', 'Acme', '$4,250.00', '@mycompany.com'] }))
  table(
    [
      ['Mail Priya Sharma <priya@x.in>', 'Mail Priya Sharma <[email]>'],
      ['Sarah Connor and Priya Sharma', '[name] and Priya Sharma'],
      ['dev@mycompany.com and dev@mail.mycompany.com and dev@other.com', 'dev@mycompany.com and dev@mail.mycompany.com and [email]'],
      ['paid $4,250.00 and $4,250.01', 'paid $4,250.00 and [amount]'],
    ],
    c,
  )
})

test('styles: bar keeps the length, partial keeps a hint, label names the kind', () => {
  const line = 'From: Jane Doe <jane@x.com>, call +44 7700 900123 about $4,250.00, card 4111 1111 1111 1111, key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123, /Users/alice/x, 12 High Street'
  const bar = maskText(line, compile(rules()))
  expect(bar.length, 'bars keep the line length').toBe(line.length)
  expect(bar).toContain(`From: ${BAR.repeat(4)} ${BAR.repeat(3)} <${BAR.repeat(10)}>`)
  const partial = maskText(line, compile(rules({ style: 'partial' })))
  expect(partial).toContain('From: J*** D*** <j***@x***.com>')
  expect(partial).toContain('+** **** ****23')
  expect(partial).toContain('$*,***.**')
  expect(partial).toContain('**** **** **** 1111')
  expect(partial).toContain('sk-********')
  expect(partial).toContain('/Users/a***/x')
  expect(partial).not.toContain('jane')
  const label = maskText(line, compile(rules({ style: 'label' })))
  expect(label).toContain('From: [name] <[email]>, call [phone] about [amount], card [number], key [secret], /Users/[user]/x, [address]')
  expect(draw('ab', 'name', 'partial')).toBe('**')
  expect(draw('Jane', 'name', 'bar', '█')).toBe('████')
})

test('the glyph of a bar can be changed, and spaces inside a hit stay spaces', () => {
  expect(maskText('Mail jane@x.com', compile(rules({ glyph: '█' })))).toBe('Mail ██████████')
  expect(maskText('Call +44 7700 900123', compile(rules({ glyph: '•' })))).toBe('Call ••• •••• ••••••')
})

test('categories: each one can be turned off on its own', () => {
  const line = 'jane@x.com +44 7700 900123 $4,250.00 sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 4111 1111 1111 1111 /Users/alice/x 12 High Street To: Jane Doe'
  const off = (kind: keyof Rules['kinds']) => tag(line, compile(rules({ kinds: { [kind]: false } as Rules['kinds'] })))
  expect(off('email')).toContain('jane@x.com')
  expect(off('phone')).toContain('+44 7700 900123')
  expect(off('amount')).toContain('$4,250.00')
  expect(off('secret')).toContain('sk-ant-api03')
  expect(off('number')).toContain('4111 1111 1111 1111')
  expect(off('path')).toContain('/Users/alice/x')
  expect(off('address')).toContain('12 High Street')
  expect(off('name')).toContain('To: Jane Doe')
  expect(tag(line)).toBe('[email] [phone] [amount] [secret] [number] /Users/[path]/x [address] To: [name]')
  const none = compile(rules({ kinds: { email: false, phone: false, amount: false, name: false, secret: false, number: false, path: false, address: false, custom: false } }))
  expect(tag(line, none)).toBe(line)
})

test('a half-written email or key at the end of a streaming text is hidden until it is whole', () => {
  table([
    ['Write to jane@acme', 'Write to [email]'],
    ['Write to jane@', 'Write to [email]'],
    ['The key is sk-ant-api03-abc', 'The key is [secret]'],
    ['Call +44 7700 9', 'Call [phone]'],
    ['We shipped react@18', 'We shipped [email]'],
    ['Write to jane@acme.com and then', 'Write to [email] and then'],
    ['Thanks @alex', 'Thanks @alex'],
  ])
})

test('maskText: the same text twice is the same answer, a clean text is the same string, masked text is not masked again', () => {
  const long = `${'Plain words about nothing. '.repeat(20)}Mail jane@x.com`
  const once = maskText(long, C)
  expect(maskText(long, C), 'cached answer').toBe(once)
  expect(maskText('nothing private here', C)).toBe('nothing private here')
  expect(maskText(once, C), 'idempotent').toBe(once)
  expect(leaks(once, C), 'a masked text holds nothing to hide').toBe(false)
  expect(leaks(long, C)).toBe(true)
  expect(maskText('', C)).toBe('')
  expect(maskText(undefined as never, C)).toBeUndefined()
  expect(hiddenRow('abc')).toContain('hidden by screen share')
  expect(hiddenRow(12 as never)).toContain('hidden by screen share')
  expect(hiddenRow('x'.repeat(100)).length, 'a placeholder does not leak the length of a long row').toBeLessThan(80)
})

test('maskDeep: strings inside plain data, ids and shape kept, private fields hidden whole', () => {
  const data = {
    tool_use_id: 'toolu_01abc',
    id: 'a@b.co',
    type: 'text',
    stdout: 'Mail jane@x.com about $4,250.00',
    exitCode: 0,
    ok: true,
    nothing: null,
    list: ['+44 7700 900123', 'plain', 12],
    customer: { first_name: 'Ravi', last_name: 'K', email: 'weird address', phone: '555 1234', note: 'fine' },
    shipping: { address1: '1 Main Street', zip: '90210', city: 'Paris' },
    name: 'screen-share',
    deep: { a: { b: { c: 'jane@x.com' } } },
  }
  const out = maskDeep(data, compile(rules({ style: 'label' }))) as typeof data
  expect(out.tool_use_id, 'ids pass').toBe('toolu_01abc')
  expect(out.id, 'ids pass untouched, even an email shape').toBe('a@b.co')
  expect(out.type).toBe('text')
  expect(out.stdout).toBe('Mail [email] about [amount]')
  expect(out.exitCode).toBe(0)
  expect(out.ok).toBe(true)
  expect(out.nothing).toBeNull()
  expect(out.list).toEqual(['[phone]', 'plain', 12])
  expect(out.customer).toEqual({ first_name: '[name]', last_name: '[name]', email: '[email]', phone: '[phone]', note: 'fine' })
  expect(out.shipping).toEqual({ address1: '[address]', zip: '[address]', city: 'Paris' })
  expect(out.name, 'a plain name key stays when there is no email beside it').toBe('screen-share')
  expect(out.deep.a.b.c).toBe('[email]')
  expect(Object.keys(out), 'same keys, same order').toEqual(Object.keys(data))
  // a name beside an email key is a person
  expect((maskDeep({ name: 'Jane Doe', email: 'j@x.com' }, C) as { name: string }).name).toBe(BAR.repeat(4) + ' ' + BAR.repeat(3))
  // nothing private: the same object comes back
  const clean = { a: ['x', { b: 'y' }], n: 1 }
  expect(maskDeep(clean, C), 'unchanged data is the same object').toBe(clean)
  // a class instance and a too-deep value are not walked blindly
  expect(() => maskDeep(JSON.parse('{"a":'.repeat(60) + '1' + '}'.repeat(60)), C)).toThrow()
  expect(keyKind('First-Name')).toBe('name')
  expect(keyKind('shoe_size')).toBeUndefined()
})

test('findSpans: sorted, no overlaps, and a span that is two things is drawn once', () => {
  const text = 'Contact Jane Doe <jane@x.com> or Jane Doe on +44 7700 900123 about $4,250.00'
  const spans = findSpans(text, C)
  for (let i = 1; i < spans.length; i++) expect(spans[i]!.a, 'no overlap').toBeGreaterThanOrEqual(spans[i - 1]!.b)
  expect(spans.map(s => s.kind)).toEqual(['name', 'email', 'name', 'phone', 'amount'])
  expect(findSpans('', C)).toEqual([])
  expect(findSpans(42 as never, C)).toEqual([])
})

test('a user name is read from the home folder only when it is not an ordinary word', () => {
  expect(usernameOf('/Users/janedoe')).toBe('janedoe')
  expect(usernameOf('/Users/test')).toBeUndefined()
  expect(usernameOf('/home/ab')).toBeUndefined()
  expect(usernameOf('')).toBeUndefined()
})

test('speed: a megabyte of mixed text is hidden in about a second, and the second look is free', () => {
  const para = 'The quick Brown fox jumps over 12 lazy dogs on 2026-11-01 at 14:30. Contact Jane Doe <jane@acme.com> or +44 7700 900123 about $4,250.00. Version v2.1.309, 182k tokens, hash 9fceb02d0ae598e95dc970b74767f19372d61af8.\n'
  const big = para.repeat(Math.ceil(1_000_000 / para.length))
  const t0 = Date.now()
  const out = maskText(big, C)
  const ms = Date.now() - t0
  expect(out).not.toContain('jane@acme.com')
  expect(ms, `1 MB took ${ms} ms`).toBeLessThan(6000)
  const t1 = Date.now()
  maskText(big, C)
  expect(Date.now() - t1, 'cached').toBeLessThan(500)
  // Awkward inputs must not blow up: long digit runs, long runs of @, hyphens, dots.
  for (const nasty of ['1234567890'.repeat(20000), 'a@'.repeat(50000), '-'.repeat(200000), '1.2.3.4.5.6.7.8.9.'.repeat(10000), '$1,2,3,4,5,6,7,8 '.repeat(10000), 'Alpha Beta Gamma '.repeat(20000)]) {
    const t = Date.now()
    maskText(nasty, C)
    expect(Date.now() - t, 'awkward input').toBeLessThan(6000)
  }
})
