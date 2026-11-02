// The masking rules for Screen Share. Pure functions: no engine calls, no state but two caches.
//
// A "span" is a stretch of text that must not be drawn. findSpans() finds them, draw() says what to
// draw in their place (a bar, a partial like j***@d***.com, or a label like [email]), and maskText()
// and maskDeep() put the two together for a string or for plain data (a tool's input or result).
//
// Detection leans cautious about plain numbers (a year, a version, a token count like 182k, a file
// size, a git hash, an order number) and eager about anything that says it is private (an @, a
// currency sign, a phone shape, a key name, a card that passes its checksum).

import { AMBIGUOUS_FIRST, DEFAULT_ALLOW, FIRST_NAMES, NOT_NAME_WORDS, SURNAMES } from './words'

export type Kind = 'email' | 'phone' | 'amount' | 'name' | 'secret' | 'number' | 'path' | 'address' | 'custom'
export type Style = 'bar' | 'partial' | 'label'
export type NameMode = 'off' | 'context' | 'smart'
export type Span = { a: number; b: number; kind: Kind }

export const KINDS: readonly Kind[] = ['email', 'phone', 'amount', 'name', 'secret', 'number', 'path', 'address', 'custom']
export const STYLES: readonly Style[] = ['bar', 'partial', 'label']
export const NAME_MODES: readonly NameMode[] = ['off', 'context', 'smart']

/** What a hidden span is called in the `label` style. */
export const LABELS: Record<Kind, string> = {
  email: 'email',
  phone: 'phone',
  amount: 'amount',
  name: 'name',
  secret: 'secret',
  number: 'number',
  path: 'user',
  address: 'address',
  custom: 'hidden',
}

export const BAR = '▒'
export const FADE = '░'

export type Rules = {
  /** Which kinds are hidden. `custom` is the always-mask list; it is on whenever the list is not empty. */
  kinds: Readonly<Record<Kind, boolean>>
  names: NameMode
  /** Words and phrases that are always hidden. */
  deny: readonly string[]
  /** Words and phrases that are never hidden by the automatic rules. */
  allow: readonly string[]
  style: Style
  glyph: string
}

export const DEFAULT_RULES: Rules = {
  kinds: { email: true, phone: true, amount: true, name: true, secret: true, number: true, path: true, address: true, custom: true },
  names: 'smart',
  deny: [],
  allow: [],
  style: 'bar',
  glyph: BAR,
}

export type Compiled = {
  rules: Rules
  /** Changes whenever anything that changes the drawing changes. */
  key: string
  denyRe: RegExp | null
  allowSet: ReadonlySet<string>
  allowWords: ReadonlySet<string>
  allowDomains: ReadonlySet<string>
}

// ------------------------------------------------------------------ compile

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&')
const MAX_LIST = 500
const MAX_ENTRY = 80

/** Cleans a list of words: trims, drops empties, too long or too short entries and duplicates. */
export function cleanList(list: readonly unknown[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of list) {
    if (typeof raw !== 'string') continue
    const s = raw.replace(/\s+/g, ' ').trim()
    if (s.length < 2 || s.length > MAX_ENTRY || seen.has(norm(s))) continue
    seen.add(norm(s))
    out.push(s)
    if (out.length >= MAX_LIST) break
  }
  return out
}

function denyRegex(deny: readonly string[]): RegExp | null {
  const parts: string[] = []
  const sorted = [...deny].sort((x, y) => y.length - x.length)
  for (const phrase of sorted) {
    if (/[@/:\\]/.test(phrase)) {
      parts.push(escapeRe(phrase))
      continue
    }
    const tokens = phrase.split(/[\s._-]+/).filter(Boolean)
    if (tokens.length === 0) continue
    // A phrase also matches with ., _ or - between its words: "acme corp" finds acme-corp and acme_corp.
    parts.push(tokens.map(escapeRe).join('[\\s._-]+'))
  }
  if (parts.length === 0) return null
  return new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${parts.join('|')})(?![\p{L}\p{N}])`, 'giu')
}

let lastCompiled: Compiled | undefined

export function compile(rules: Rules): Compiled {
  const deny = cleanList(rules.deny)
  const allow = cleanList([...DEFAULT_ALLOW, ...rules.allow])
  const kinds = KINDS.map(k => (rules.kinds[k] ? '1' : '0')).join('')
  const key = [kinds, rules.names, rules.style, rules.glyph, deny.join('\u0001'), allow.join('\u0001')].join('\u0000')
  if (lastCompiled && lastCompiled.key === key) return lastCompiled
  const allowSet = new Set<string>()
  const allowWords = new Set<string>()
  const allowDomains = new Set<string>()
  for (const entry of allow) {
    if (entry.startsWith('@')) allowDomains.add(norm(entry.slice(1)))
    allowSet.add(norm(entry))
    for (const w of norm(entry).split(' ')) allowWords.add(w)
  }
  lastCompiled = { rules: { ...rules, deny }, key, denyRe: rules.kinds.custom ? denyRegex(deny) : null, allowSet, allowWords, allowDomains }
  return lastCompiled
}

// ------------------------------------------------------------------ patterns

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`)\]]+/giu

// Emails. An ssh remote (git@github.com:me/repo) and a retina image name (logo@2x.png) are not emails.
const LABEL = String.raw`[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?`
const EMAIL_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}_%+-])[\p{L}\p{N}_%+-][\p{L}\p{N}._%+'-]*@${LABEL}(?:\.${LABEL})*\.\p{L}{2,24}(?![\p{L}\p{N}_-])(?!:[\w~/])`,
  'gu',
)
const RETINA_RE = /^\d+x\.(?:png|jpe?g|webp|gif|svg|avif|heic)$/i
const QUICK_RE = /[@\d$£€¥₹:=]|\p{Lu}/u

// Secrets: known token shapes, then a value after a key that says it is secret.
const SECRET_SHAPES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|[\s\S]*$)/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bshp(?:at|ss|ca|pa)_[a-f0-9]{32}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bhf_[A-Za-z0-9]{30,}/g,
  /(?<=\bBearer\s+)[A-Za-z0-9._~+/=-]{16,}/g,
  // A 40-character mixed-case key with digits (an AWS secret key). A git hash is lowercase hex and stays.
  /(?<![A-Za-z0-9/+=_.-])(?=[A-Za-z0-9/+]*[A-Z])(?=[A-Za-z0-9/+]*[a-z])(?=[A-Za-z0-9/+]*\d)[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=_.-])/g,
  // https://user:password@host  (the password)
  /(?<=:\/\/[^\s:/@]+:)[^\s@/]{3,}(?=@)/g,
  // ?api_key=...&token=...
  /(?<=[?&](?:api_?key|apikey|key|token|access_token|auth|secret|password|sig|signature)=)[^&\s#"'<>]{6,}/gi,
]
const SECRET_KEY_RE =
  /([A-Za-z0-9_.-]*(?:secret|token|password|passwd|pwd|passphrase|api[_-]?key|apikey|private[_-]?key|access[_-]?key|authorization|credential)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)([^\s"'&,;)}\]]{6,})/gi
const NOT_SECRET_VALUE = /^(?:[*x•▒█░.\-_#]+|bearer|basic|string|number|boolean|object|array|required|optional|true|false|null|none|undefined|secret|password|token|changeme|your[-_a-z]*|\$.*|<.*|\{.*|%.*|process\.env.*|os\.environ.*|env\..*)$/i

// Money.
const SYM = '[$£€¥₹₩₽₺₪₫₦₱₴₸฿₡₲₵₭₮₼₾]'
const CODES =
  'USD|EUR|GBP|JPY|CNY|CHF|CAD|AUD|NZD|INR|SGD|HKD|SEK|NOK|DKK|PLN|CZK|HUF|RON|BGN|ZAR|BRL|MXN|ARS|CLP|COP|AED|SAR|QAR|KWD|ILS|EGP|NGN|KES|THB|IDR|MYR|PHP|VND|KRW|TWD|PKR|BDT|LKR|UAH|RUB'
const NUM = String.raw`\d(?:[\d,.\u202f\u00a0']*\d)?`
const SCALE = String.raw`(?:\s?(?:[kKmMbB]|mm|bn|BN|cr|Cr)(?![\p{L}\p{N}_])|\s(?:thousand|million|billion|trillion|lakhs?|crores?)(?![\p{L}]))`
const WORDS_AFTER = String.raw`(?:${CODES}|dollars?|euros?|pounds?|quid|rupees?|rs|yen|bucks|dirhams?|€|£|₹|zł|kr|Kč|lei|₽|円|元|원)`
const MONEY_RES: RegExp[] = [
  // $1,234.56  £900  €12k  ₹4,500  US$300  R$ 50  \$500 (a dollar escaped in markdown)
  new RegExp(String.raw`(?<![\p{L}\p{N}_$])(?:[A-Z]{1,2})?\\?${SYM}\s?${NUM}(?:${SCALE})?(?![\p{L}\p{N}_%])`, 'gu'),
  // USD 300  INR 4,500  Rs. 900  Rs 1.2 lakh
  new RegExp(String.raw`(?<![\p{L}\p{N}_])(?:${CODES}|Rs\.?)\s?${NUM}(?:${SCALE})?(?![\p{L}\p{N}_%])`, 'gu'),
  // 1,200 dollars  300 USD  12€  5k euros
  new RegExp(String.raw`(?<![\p{L}\p{N}_.,$£€₹])${NUM}(?:${SCALE})?\s?${WORDS_AFTER}(?![\p{L}\p{N}_])`, 'gu'),
]
const LONE_DOLLAR_ARG_RE = /^\\?\$\d$/
const SHELL_LINE_RE = /\$@|\$\{|\$\(|\$#|\$\?|\$\$|\$0(?![.\d])|\bawk\b|\bsed\b|\bperl\b|\bxargs\b|\bgrep\b|\becho\b|\bprintf\b/
// A plain number after a word that says it is money: "total: 4,250.00", "price": 49.99.
const MONEY_WORDS =
  'total|subtotal|total_price|subtotal_price|price|unit_price|amount|balance|revenue|salary|cost|fee|fees|budget|payment|paid|refund|deposit|payout|mrr|arr|spend|charge|invoice|tax|tip|wage|income|profit|sales'
const CONTEXT_MONEY_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:${MONEY_WORDS})["']?\s*(?:[:=]|\bis\b|\bof\b|\bwas\b|\bat\b)\s*["']?(${NUM})(?![\p{L}\p{N}_%]|\.\d)`,
  'giu',
)
const NOT_MONEY_UNIT_RE = /^\s*(?:%|px|ms|s\b|kb|mb|gb|tb|tokens?|files?|items?|lines?|tests?|x\b|days?|hours?|mins?|minutes|seconds|rows|words|chars|users|orders?|pages|units|pcs|pieces)/i

// Phones: a candidate shape, then a validator that knows what a phone is not.
const PH_LEFT = String.raw`(?<![\p{L}\p{N}_/\\.#=@$£€₹¥%+-])`
const PH_RIGHT = String.raw`(?![\p{L}\p{N}_/\\@%-]|\.\d|,\d)`
const SEP = String.raw`[ .\-\u00a0]`
const PH_GROUP = String.raw`(?:\(\d{1,5}\)${SEP}?|\d{1,9}${SEP})`
const PHONE_RE = new RegExp(String.raw`${PH_LEFT}(\+?\d{8,15}|\+?${PH_GROUP}(?:${PH_GROUP}){0,6}\d{1,9})${PH_RIGHT}`, 'gu')
// An id, a reference or a part number can look like a phone; these words in front say it is not one (unless it starts with +).
const NOT_PHONE_CONTEXT_RE = /(?:sku|id|ref|order|no\.?|nr|number|serial|ticket|invoice|inv|po|case|job|build|part|item|code|tracking|account|acct)\b[^\n\d]{0,4}$/i
const PHONE_CONTEXT_RE = /(?:phone|tel|telephone|mobile|mob|cell|whatsapp|fax|call|sms|ring|dial)\b[^\n\d+(]{0,24}$/i
const DATE_RES = [
  /^(?:19|20)\d{2}[ .-]\d{1,2}[ .-]\d{1,2}$/,
  /^\d{1,2}[ .-]\d{1,2}[ .-](?:19|20)\d{2}$/,
]
const YEARS_RE = /^(?:(?:19|20)\d{2}[ .-]?){2,}$/
const IP_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/
const DECIMAL_RE = /^\d+\.\d+$/
const LAST_GROUP_RE = /[ .\-\u00a0]?\(?\d+\)?$/

// Long digit strings.
const CARD_RE = /(?<![\p{L}\p{N}_.,/-])\d(?:[ -]?\d){12,18}(?![\p{L}\p{N}_/-]|[.,]\d)/gu
const CARD_PREFIX_RE = /^(?:4|5[0-5]|2(?:2[2-9]|[3-6]\d|7[01]|720)|3[4-9]|30[0-5]|6011|65|64[4-9]|35|62|50|5[6-8])/
const IBAN_RE = /(?<![\p{L}\p{N}_])[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?(?![\p{L}\p{N}_])/gu
const SSN_RE = /(?<![\p{L}\p{N}_.-])(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\p{L}\p{N}_.-])/gu
const AADHAAR_RE = /(?<![\p{L}\p{N}_.-]|\d[ -])[2-9]\d{3} \d{4} \d{4}(?![\p{L}\p{N}_.-]|[ -]\d)/gu
const NINO_RE = /(?<![\p{L}\p{N}_])[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D](?![\p{L}\p{N}_])/gu

// Where a person lives.
const HOME_PATH_RES = [
  /(?<=\/(?:Users|home)\/)[^/\s"'`:*?<>|\\()[\]{},;]+/g,
  /(?<=\\Users\\)[^\\\s"'`:*?<>|/()[\]{},;]+/g,
]
const SHARED_DIRS = new Set(['shared', 'public', 'guest', 'runner', 'root', 'ubuntu', 'default', 'user', 'users', 'nobody'])
const STREET_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])\d{1,5}[A-Za-z]?(?:[ \t]+\p{Lu}[\p{L}'’.-]*){1,3}[ \t]+(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Drive|Dr|Boulevard|Blvd|Way|Court|Ct|Place|Pl|Terrace|Crescent|Close|Square|Sq|Highway|Hwy|Parkway|Pkwy|Strasse|Straße|Rue|Calle)\b\.?`,
  'gu',
)
const UK_POSTCODE_RE = /(?<![\p{L}\p{N}_-])[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}(?![\p{L}\p{N}_-])/gu
const US_CITY_ZIP_RE = /(?<![\p{L}\p{N}_])\p{Lu}\p{Ll}+(?:[ \t]\p{Lu}\p{Ll}+)?,[ \t]?[A-Z]{2}[ \t]\d{5}(?:-\d{4})?(?![\p{L}\p{N}_-])/gu

// Names. Only where the text says it is a person, or where two words look like a first and last name.
const W = String.raw`(?:Mc|Mac|O['’])?\p{Lu}[\p{Ll}\p{M}]+(?:-\p{Lu}[\p{Ll}\p{M}]+)?`
const PARTICLE = String.raw`(?:van|von|de|der|den|da|di|du|la|le|del|della|dos|das|bin|bint|ibn|al|el|ter|ten)`
const NAME_PHRASE = String.raw`${W}(?:[ \t]+(?:${PARTICLE}[ \t]+){0,2}(?:\p{Lu}\.[ \t]+)?${W}){0,3}`
const PARTICLES = new Set(['van', 'von', 'de', 'der', 'den', 'da', 'di', 'du', 'la', 'le', 'del', 'della', 'dos', 'das', 'bin', 'bint', 'ibn', 'al', 'el', 'ter', 'ten'])
// Words that open a phrase but are not part of the name after them.
const LEAD_WORDS = new Set([
  'from', 'to', 'cc', 'bcc', 'mail', 'email', 'contact', 'call', 'hi', 'hello', 'hey', 'dear', 'thanks', 'thank', 'ask', 'ping', 'message', 'write', 'send', 'reply',
  'by', 'and', 'or', 'the', 'sender', 'recipient', 'with', 'via', 'name', 'owner', 'lead', 'customer', 'client', 'attn', 'sincerely', 'regards', 'best', 'cheers',
])
const NAME_CHARS_RE = new RegExp(String.raw`^${NAME_PHRASE}$`, 'u')
const BEFORE_EMAIL_RE = new RegExp(String.raw`(${NAME_PHRASE})["'’*_]*[ \t]*(?:<|\(|\[|\||,|:|-|–|—)[ \t]*<?[ \t]*$`, 'u')
const QUOTED_BEFORE_RE = /"([^"\n<>@]{2,60})"[ \t]*<[ \t]*$/
const AFTER_EMAIL_RE = new RegExp(String.raw`^>?[ \t]*(?:\([ \t]*(${NAME_PHRASE})[ \t]*\)|\|[ \t]*(${NAME_PHRASE})[ \t]*\||[-–—][ \t]*(${NAME_PHRASE}))`, 'u')
const GREETING_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])(?:Hi|Hello|Hey|Dear|Thanks|Thank you|Cheers|Hola|Bonjour|Hallo|Ciao|Namaste|Attn|Attention)[,:]?[ \t]+(${NAME_PHRASE})`,
  'gu',
)
const SIGNOFF_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])(?:Best regards|Kind regards|Warm regards|Regards|Best wishes|Best|Sincerely|Cheers|Thanks|Thank you|Love|Yours)[,!.]?[ \t]*\r?\n[ \t]*(${NAME_PHRASE})[ \t]*(?:\r?\n|$)`,
  'gu',
)
const TITLE_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])(?:Mr|Mrs|Ms|Miss|Mx|Dr|Prof|Professor|Herr|Frau|Mme|Mlle|Shri|Smt)\.?[ \t]+(${NAME_PHRASE})`,
  'gu',
)
const INTRO_RE = new RegExp(String.raw`(?<![\p{L}\p{N}_])(?:[Mm]y name is|[Mm]y name's|[Nn]ame is|[Cc]all me|I am called)[ \t]+(${NAME_PHRASE})`, 'gu')
// First name: Ravi; Last name: Kumar. Several labels can share a line.
const NAME_LABEL_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])(?:First|Last|Full|Display|Given|Family|Sender|Customer|Contact|Billing|Shipping|Recipient)[ _]?[Nn]ame["']?[ \t]*[:=][ \t]*["']?(${NAME_PHRASE})`,
  'gu',
)
const LABEL_LINE_RE =
  /^([ \t>*_-]*[*_]{0,2}(?:From|To|Cc|Bcc|Reply-To|Sender|Recipients?|Attendees?|Organi[sz]er|Invitees?|Guests?|Contact|Full[ _]name|First[ _]name|Last[ _]name|Name|Customer|Client|Owner|Assignee|Assigned to|Author|Reporter|Requester|Requested by|Created by|Updated by|Sold to|Ship to|Bill to|Cardholder|Account holder|Beneficiary|Payee|Payer|Buyer|Patient|Employee|Candidate|Prepared by|Approved by|Reviewed by|Signed)[*_]{0,2}[ \t]*:[*_]{0,2}[ \t]*)([^\n]*)$/gimu
const PART_SPLIT_RE = /,|;|[ \t]+and[ \t]+|[ \t]+&[ \t]+/g
const PART_NAME_RE = new RegExp(String.raw`^[ \t]*[*_"']{0,2}(${NAME_PHRASE})[*_"']{0,2}[ \t]*(?=$|<|\(|\[|\|)`, 'u')
const CANDIDATE_RE = new RegExp(String.raw`(?<![\p{L}\p{N}_@./\\#-])${NAME_PHRASE}(?![\p{L}\p{N}_@/\\-])`, 'gu')

// Fields that say what their value is. The value is hidden whole, whatever it looks like.
const PII_KEYS: Record<string, Kind> = {}
for (const k of 'first_name firstname last_name lastname full_name fullname display_name given_name family_name surname sender_name from_name to_name contact_name customer_name billing_name shipping_name recipient_name cardholder cardholder_name author_name owner_name person_name assignee_name'.split(' ')) PII_KEYS[k] = 'name'
for (const k of 'email e_mail email_address contact_email customer_email billing_email sender_email recipient_email'.split(' ')) PII_KEYS[k] = 'email'
for (const k of 'phone phone_number mobile mobile_number telephone tel fax whatsapp contact_phone cell cell_phone'.split(' ')) PII_KEYS[k] = 'phone'
for (const k of 'address address1 address2 street street_address billing_address shipping_address postal_code postcode zip zip_code dob date_of_birth birthday birth_date'.split(' ')) PII_KEYS[k] = 'address'
for (const k of 'ssn tax_id national_id passport passport_number card_number iban account_number routing_number'.split(' ')) PII_KEYS[k] = 'number'
for (const k of 'password passwd secret client_secret api_key apikey access_token auth_token refresh_token private_key authorization'.split(' ')) PII_KEYS[k] = 'secret'
const PII_KEY_LIST = Object.keys(PII_KEYS).sort((x, y) => y.length - x.length).join('|')
const PII_KV_RE = new RegExp(
  String.raw`(["']?)(?<![\p{L}\p{N}])(${PII_KEY_LIST})\1\s*[:=]\s*(?:"((?:[^"\\\n]|\\.){1,200})"|'([^'\n]{1,200})'|([^\s,;}\]"']{1,120}))`,
  'giu',
)
const NAME_ONLY_KV_RE = /(["'])name\1\s*:\s*"([^"\\\n]{1,80})"/g
const HAS_EMAIL_KEY_RE = /["']e-?mail(?:_?address)?["']\s*:/i
const FLAT_OBJECT_RE = /\{[^{}]{0,3000}\}/g
// A type name or a template slot after a field name (address: string, email: {{email}}) is not data.
const NOT_FIELD_VALUE_RE = /^(?:string|number|boolean|any|unknown|object|void|never|undefined|null|true|false|text|required|optional|array|\w+\[\]|(?:Array|Record|Promise|Partial)<.*>|\$.*|\{\{.*|<.*)$/i
const EMPTY_VALUE_RE = /^(?:null|none|undefined|true|false|n\/a|-|0|""|''|[*x•▒█░]+)$/i

/** Keys whose string value is private and is hidden whole inside plain data. */
export function keyKind(key: string): Kind | undefined {
  return PII_KEYS[key.toLowerCase().replace(/[-\s]/g, '_')]
}
const EMAIL_KEY_RE = /^e-?mail(?:_?address)?$/i
/** Keys that carry ids or structure; their values are never touched. */
const SKIP_KEYS = new Set(['tool_use_id', 'id', 'uuid', 'requestId', 'tool', 'type', 'kind', 'role', 'status', 'mediaType', 'media_type', 'encoding', 'base64', 'model'])

// ------------------------------------------------------------------ helpers

const digitCount = (s: string) => s.replace(/\D/g, '').length

function taken(used: Uint8Array, a: number, b: number) {
  for (let i = a; i < b; i++) if (used[i]) return true
  return false
}
function take(used: Uint8Array, a: number, b: number) {
  used.fill(1, a, b)
}

function luhn(digits: string) {
  let sum = 0
  let dbl = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (dbl) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    dbl = !dbl
  }
  return sum % 10 === 0
}

function ibanOk(raw: string) {
  const s = raw.replace(/ /g, '')
  if (s.length < 15 || s.length > 34) return false
  const moved = s.slice(4) + s.slice(0, 4)
  let rem = 0
  for (const ch of moved) {
    const v = ch >= 'A' ? ch.charCodeAt(0) - 55 : ch.charCodeAt(0) - 48
    rem = Number(`${rem}${v}`) % 97
  }
  return rem === 1
}

/** How much of a phone-shaped hit is the phone: the whole, or less once a trailing year is cut off. 0 when none. */
function phoneLength(hit: string, context: boolean): number {
  const plus = hit.startsWith('+')
  const structured = /[ .\-\u00a0()]/.test(hit)
  let h = hit
  while (h) {
    if (isPhone(h, plus, structured, context)) return h.length
    // Only a hit that is too long, or ends in a year, is cut back; an IP address or a version is not a phone.
    const last = /(\d+)\)?$/.exec(h)?.[1] ?? ''
    if (digitCount(h) <= 15 && !/^(?:19|20)\d{2}$/.test(last)) return 0
    const cut = h.replace(LAST_GROUP_RE, '')
    if (cut === h || digitCount(cut) < 8) return 0
    h = cut
  }
  return 0
}

function isPhone(h: string, plus: boolean, structured: boolean, context: boolean) {
  const n = digitCount(h)
  if (n > 15) return false
  const bare = h.replace(/^\+/, '')
  if (DATE_RES.some(r => r.test(bare)) || YEARS_RE.test(bare) || IP_RE.test(bare) || DECIMAL_RE.test(bare)) return false
  if (structured) {
    if (plus || /^\(/.test(h)) return n >= 8
    if (context) return n >= 7
    if (n < 9 || n > 11) return false
    // 10 20 30 40 50 is a list of numbers; 06 12 34 56 78 is a French phone (it starts with 0).
    const groups = h.split(/[ .\-\u00a0()]+/).filter(Boolean)
    const short = groups.filter(g => g.length <= 2).length
    return short * 2 < groups.length || h.startsWith('0')
  }
  // A bare run of digits is a phone only in a shape that is clearly one, or after a word like "call".
  if (plus) return n >= 8
  if (context) return n >= 7
  if (/^0?[6-9]\d{9}$/.test(h) || /^91[6-9]\d{9}$/.test(h)) return true
  if (/^07\d{9}$/.test(h) || /^447\d{9}$/.test(h)) return true
  if (/^1[2-9]\d{2}[2-9]\d{6}$/.test(h)) return true
  return false
}

function trimStop(words: string[], start: number): { words: string[]; start: number } {
  let s = start
  const w = words.slice()
  while (w.length && (LEAD_WORDS.has((w[0] ?? '').toLowerCase()) || NOT_NAME_WORDS.has((w[0] ?? '').toLowerCase()))) {
    s += (w[0] ?? '').length + 1
    w.shift()
  }
  return { words: w, start: s }
}

const isSpaceChar = (c: string | undefined) => c === ' ' || c === '\t'

// ------------------------------------------------------------------ detectors

function emailSpans(text: string, spans: Span[]) {
  EMAIL_RE.lastIndex = 0
  for (const m of text.matchAll(EMAIL_RE)) {
    const hit = m[0]
    if (RETINA_RE.test(hit.slice(hit.indexOf('@') + 1))) continue
    const a = m.index ?? 0
    spans.push({ a, b: a + hit.length, kind: 'email' })
  }
}

function secretSpans(text: string, spans: Span[]) {
  for (const re of SECRET_SHAPES) {
    re.lastIndex = 0
    for (const m of text.matchAll(re)) spans.push({ a: m.index ?? 0, b: (m.index ?? 0) + m[0].length, kind: 'secret' })
  }
  if (/[:=]/.test(text)) {
    SECRET_KEY_RE.lastIndex = 0
    for (const m of text.matchAll(SECRET_KEY_RE)) {
      const value = m[3] ?? ''
      if (NOT_SECRET_VALUE.test(value) || (/^\d+$/.test(value) && value.length <= 10)) continue
      const a = (m.index ?? 0) + (m[1] ?? '').length + (m[2] ?? '').length
      spans.push({ a, b: a + value.length, kind: 'secret' })
    }
  }
}

function moneySpans(text: string, spans: Span[], used: Uint8Array, inLink: Uint8Array | null) {
  for (const re of MONEY_RES) {
    re.lastIndex = 0
    for (const m of text.matchAll(re)) {
      const a = m.index ?? 0
      const b = a + m[0].length
      if (LONE_DOLLAR_ARG_RE.test(m[0])) {
        // $1 is a shell argument in a script, five dollars in a sentence.
        const next = text[b] ?? ''
        const line = text.slice(text.lastIndexOf('\n', a) + 1, (text.indexOf('\n', b) + 1 || text.length + 1) - 1)
        if (SHELL_LINE_RE.test(line) || (a > 0 && /["']/.test(text[a - 1] ?? '') && /["']/.test(next)) || /[})|;]/.test(next)) continue
      }
      if ((inLink && taken(inLink, a, b)) || taken(used, a, b)) continue
      spans.push({ a, b, kind: 'amount' })
      take(used, a, b)
    }
  }
  if (/[:=]|\bis\b|\bof\b|\bwas\b|\bat\b/i.test(text)) {
    CONTEXT_MONEY_RE.lastIndex = 0
    for (const m of text.matchAll(CONTEXT_MONEY_RE)) {
      const num = m[1] ?? ''
      const b = (m.index ?? 0) + m[0].length
      const a = b - num.length
      const grouped = /\d[,.\u202f\u00a0']\d{3}\b/.test(num) && /,\d{3}/.test(num)
      const cents = /\.\d{2}$/.test(num)
      const big = /^\d{4,}$/.test(num) && !/^(?:19|20)\d{2}$/.test(num)
      if (!(grouped || cents || big)) continue
      if (NOT_MONEY_UNIT_RE.test(text.slice(b, b + 12))) continue
      if ((inLink && taken(inLink, a, b)) || taken(used, a, b)) continue
      spans.push({ a, b, kind: 'amount' })
      take(used, a, b)
    }
  }
}

function phoneSpans(text: string, spans: Span[], used: Uint8Array, inLink: Uint8Array | null) {
  PHONE_RE.lastIndex = 0
  for (const m of text.matchAll(PHONE_RE)) {
    const hit = m[1] ?? ''
    const a = (m.index ?? 0) + (m[0].length - hit.length)
    if (inLink && taken(inLink, a, a + hit.length)) continue
    const before = text.slice(Math.max(0, a - 40), a)
    if (!hit.startsWith('+') && NOT_PHONE_CONTEXT_RE.test(before)) continue
    const context = PHONE_CONTEXT_RE.test(before)
    const n = phoneLength(hit, context)
    if (n === 0 || taken(used, a, a + n)) continue
    spans.push({ a, b: a + n, kind: 'phone' })
    take(used, a, a + n)
  }
}

function numberSpans(text: string, spans: Span[], used: Uint8Array, inLink: Uint8Array | null) {
  CARD_RE.lastIndex = 0
  for (const m of text.matchAll(CARD_RE)) {
    const hit = m[0]
    const a = m.index ?? 0
    const digits = hit.replace(/\D/g, '')
    if (digits.length < 13 || digits.length > 19 || !CARD_PREFIX_RE.test(digits) || !luhn(digits)) continue
    const seps = hit.replace(/\d/g, '')
    if (new Set(seps).size > 1) continue
    if ((inLink && taken(inLink, a, a + hit.length)) || taken(used, a, a + hit.length)) continue
    spans.push({ a, b: a + hit.length, kind: 'number' })
    take(used, a, a + hit.length)
  }
  for (const re of [IBAN_RE, SSN_RE, AADHAAR_RE, NINO_RE]) {
    re.lastIndex = 0
    for (const m of text.matchAll(re)) {
      const a = m.index ?? 0
      if (re === IBAN_RE && !ibanOk(m[0])) continue
      // 2024 2025 2026 is three years, not an ID number.
      if (re === AADHAAR_RE && m[0].split(' ').filter(g => /^(?:19|20)\d{2}$/.test(g)).length >= 2) continue
      if ((inLink && taken(inLink, a, a + m[0].length)) || taken(used, a, a + m[0].length)) continue
      spans.push({ a, b: a + m[0].length, kind: 'number' })
      take(used, a, a + m[0].length)
    }
  }
}

function pathSpans(text: string, spans: Span[]) {
  if (!text.includes('Users') && !text.includes('home')) return
  for (const re of HOME_PATH_RES) {
    re.lastIndex = 0
    for (const m of text.matchAll(re)) {
      if (SHARED_DIRS.has(m[0].toLowerCase())) continue
      spans.push({ a: m.index ?? 0, b: (m.index ?? 0) + m[0].length, kind: 'path' })
    }
  }
}

function addressSpans(text: string, spans: Span[], used: Uint8Array) {
  for (const re of [STREET_RE, UK_POSTCODE_RE, US_CITY_ZIP_RE]) {
    re.lastIndex = 0
    for (const m of text.matchAll(re)) {
      const a = m.index ?? 0
      if (taken(used, a, a + m[0].length)) continue
      spans.push({ a, b: a + m[0].length, kind: 'address' })
    }
  }
}

function customSpans(text: string, c: Compiled, spans: Span[]) {
  const re = c.denyRe
  if (!re) return
  re.lastIndex = 0
  for (const m of text.matchAll(re)) spans.push({ a: m.index ?? 0, b: (m.index ?? 0) + m[0].length, kind: 'custom' })
}

/** The words of `name`, each with where it starts, for the name rules. */
function wordsOf(name: string) {
  const out: Array<{ w: string; at: number }> = []
  const re = /\S+/g
  for (const m of name.matchAll(re)) out.push({ w: m[0], at: m.index ?? 0 })
  return out
}

function strictName(words: string[]) {
  const real = words.filter(w => !PARTICLES.has(w.toLowerCase()))
  return real.length > 0 && real.every(w => !NOT_NAME_WORDS.has(w.toLowerCase().replace(/[’']s$/, '')))
}

/**
 * Adds a name found at `at`. `trim` drops opener words (Contact, From, Hi) from its front first; `exact` takes the
 * phrase as it is. Every word left must be one that could belong to a person, and there must be `min` of them.
 */
function addName(spans: Span[], used: Uint8Array, text: string, name: string, at: number, min: number, mode: 'trim' | 'exact' = 'exact') {
  const parts = wordsOf(name)
  const words = mode === 'trim' ? trimStop(parts.map(p => p.w), at).words : parts.map(p => p.w)
  const real = words.filter(w => !PARTICLES.has(w.toLowerCase()))
  if (real.length < min || words.length === 0 || !strictName(words)) return
  const first = parts[parts.length - words.length]
  if (!first) return
  const a = at + first.at
  const slice = text.slice(a, at + name.length).replace(/[ \t]+$/, '')
  if (!slice || taken(used, a, a + slice.length)) return
  spans.push({ a, b: a + slice.length, kind: 'name' })
}

function nameSpans(text: string, c: Compiled, spans: Span[], used: Uint8Array, emails: Span[], inLink: Uint8Array | null) {
  const smart = c.rules.names === 'smart'
  // 1. Next to an email: Name <mail>, "Name" <mail>, mail (Name), | Name | mail |, mail - Name.
  for (const e of emails) {
    let from = Math.max(0, e.a - 90)
    while (from > 0 && !/\s/.test(text[from - 1] ?? ' ')) from++
    const before = text.slice(from, e.a)
    const q = QUOTED_BEFORE_RE.exec(before)
    if (q?.[1]) addName(spans, used, text, q[1], from + (q.index ?? 0) + 1, 1, 'exact')
    else {
      const m = BEFORE_EMAIL_RE.exec(before)
      if (m?.[1]) {
        const sep = before.slice(m.index + m[1].length).replace(/["'’*_\s]/g, '')[0] ?? ''
        addName(spans, used, text, m[1], from + m.index, sep === '<' || sep === '(' || sep === '[' ? 1 : 2, 'trim')
      }
    }
    const after = text.slice(e.b, e.b + 90)
    const n = AFTER_EMAIL_RE.exec(after)
    const name = n?.[1] ?? n?.[2] ?? n?.[3]
    if (n && name) addName(spans, used, text, name, e.b + n[0].indexOf(name), n[1] ? 1 : 2)
  }
  // 2. Said outright: greetings, sign-offs, titles, "my name is".
  for (const [re, min] of [[GREETING_RE, 1], [TITLE_RE, 1], [INTRO_RE, 1], [SIGNOFF_RE, 1], [NAME_LABEL_RE, 1]] as const) {
    re.lastIndex = 0
    for (const m of text.matchAll(re)) {
      const name = m[1] ?? ''
      addName(spans, used, text, name, (m.index ?? 0) + m[0].indexOf(name, re === SIGNOFF_RE ? m[0].search(/\n/) : 0), min, 'exact')
    }
  }
  // 3. From:, To:, Name:, Customer: lines.
  if (text.includes(':')) {
    LABEL_LINE_RE.lastIndex = 0
    for (const m of text.matchAll(LABEL_LINE_RE)) {
      const label = m[1] ?? ''
      const rest = m[2] ?? ''
      const at = (m.index ?? 0) + label.length
      let last = 0
      const parts: Array<[string, number]> = []
      PART_SPLIT_RE.lastIndex = 0
      for (const sep of rest.matchAll(PART_SPLIT_RE)) {
        parts.push([rest.slice(last, sep.index), last])
        last = (sep.index ?? 0) + sep[0].length
      }
      parts.push([rest.slice(last), last])
      for (const [part, off] of parts) {
        const pm = PART_NAME_RE.exec(part)
        if (pm?.[1]) addName(spans, used, text, pm[1], at + off + part.indexOf(pm[1]), 1)
      }
    }
  }
  // 4. A flat JSON object with an email key: its "name" is a person.
  if (text.includes('"') && text.includes('@')) {
    FLAT_OBJECT_RE.lastIndex = 0
    for (const o of text.matchAll(FLAT_OBJECT_RE)) {
      if (!HAS_EMAIL_KEY_RE.test(o[0])) continue
      NAME_ONLY_KV_RE.lastIndex = 0
      for (const m of o[0].matchAll(NAME_ONLY_KV_RE)) {
        const v = m[2] ?? ''
        const end = (o.index ?? 0) + (m.index ?? 0) + m[0].length - 1
        if (/^\p{L}/u.test(v) && !taken(used, end - v.length, end)) spans.push({ a: end - v.length, b: end, kind: 'name' })
      }
    }
  }
  // 5. Smart: two words that look like a first and last name.
  if (smart) {
    CANDIDATE_RE.lastIndex = 0
    for (const m of text.matchAll(CANDIDATE_RE)) {
      const start = m.index ?? 0
      if (inLink && taken(inLink, start, start + m[0].length)) continue
      const parts = wordsOf(m[0])
      for (let i = 0; i < parts.length - 1; i++) {
        const w = (parts[i]?.w ?? '').toLowerCase()
        const next = (parts[i + 1]?.w ?? '').toLowerCase()
        if (PARTICLES.has(w) || NOT_NAME_WORDS.has(next.replace(/[’']s$/, ''))) continue
        const firstOk = FIRST_NAMES.has(w) && !NOT_NAME_WORDS.has(w)
        const ambiguousOk = AMBIGUOUS_FIRST.has(w) && SURNAMES.has(next)
        if (!firstOk && !ambiguousOk) continue
        let last = i + 1
        const third = (parts[i + 2]?.w ?? '').toLowerCase()
        if (last + 1 < parts.length && third && !NOT_NAME_WORDS.has(third) && !PARTICLES.has(third) && firstOk) last = i + 2
        const a = start + (parts[i]?.at ?? 0)
        const lastPart = parts[last]
        const b = start + (lastPart?.at ?? 0) + (lastPart?.w.length ?? 0)
        if (!taken(used, a, b)) {
          spans.push({ a, b, kind: 'name' })
          take(used, a, b)
        }
        i = last
      }
    }
  }
}

function keyedSpans(text: string, c: Compiled, spans: Span[], used: Uint8Array) {
  PII_KV_RE.lastIndex = 0
  for (const m of text.matchAll(PII_KV_RE)) {
    const kind = PII_KEYS[(m[2] ?? '').toLowerCase()]
    if (!kind || !c.rules.kinds[kind]) continue
    const value = m[3] ?? m[4] ?? m[5] ?? ''
    if (!value || EMPTY_VALUE_RE.test(value) || value.length < 2) continue
    if (NOT_SECRET_VALUE.test(value) || NOT_FIELD_VALUE_RE.test(value)) continue
    const b = (m.index ?? 0) + m[0].length - (m[3] !== undefined || m[4] !== undefined ? 1 : 0)
    const a = b - value.length
    if (taken(used, a, b)) continue
    spans.push({ a, b, kind })
    take(used, a, b)
  }
}

/** The last word of a text that is still being typed or streamed: hide it while it is half an email or key. */
function tailSpan(text: string, c: Compiled, spans: Span[]) {
  const end = text.length
  if (end === 0 || /\s/.test(text[end - 1] ?? ' ')) return
  let a = end
  while (a > 0 && !/\s/.test(text[a - 1] ?? ' ')) a--
  const t = text.slice(a)
  // An international number being typed has spaces in it: look back over the last few groups.
  if (c.rules.kinds.phone) {
    const m = /(?<![\p{L}\p{N}_/+$£€-])\+\d[\d ()\-.]{3,}$/u.exec(text.slice(Math.max(0, end - 30)))
    if (m && digitCount(m[0]) >= 5 && !spans.some(s => s.b > end - m[0].length)) {
      spans.push({ a: end - m[0].length, b: end, kind: 'phone' })
      return
    }
  }
  if (t.length < 3 || spans.some(s => s.b > a)) return
  // A text that ends in something that looks whole, like logo@3x.webp, was left alone on purpose.
  if (c.rules.kinds.email && /[\p{L}\p{N}]@[\p{L}\p{N}.-]*$/u.test(t) && !/^@/.test(t) && !/\.\p{L}{2,}$/u.test(t)) spans.push({ a, b: end, kind: 'email' })
  else if (c.rules.kinds.secret && /^(?:sk-|ghp_|gho_|github_pat_|xox[abprs]-|AKIA|AIza|eyJ|shp(?:at|ss)_|npm_|glpat-|hf_|sk_live|pk_live)/.test(t) && t.length >= 6)
    spans.push({ a, b: end, kind: 'secret' })
}

// ------------------------------------------------------------------ spans

const PRIORITY: Record<Kind, number> = { custom: 9, secret: 8, email: 7, number: 6, amount: 5, phone: 4, address: 3, name: 2, path: 1 }

function allowed(text: string, s: Span, c: Compiled) {
  if (s.kind === 'custom') return false
  const hit = text.slice(s.a, s.b)
  const n = norm(hit)
  if (c.allowSet.has(n)) return true
  if (s.kind === 'email') {
    const domain = n.slice(n.indexOf('@') + 1)
    for (const d of c.allowDomains) if (domain === d || domain.endsWith(`.${d}`)) return true
  }
  if (s.kind === 'name') {
    const words = n.split(' ')
    if (words.length > 0 && words.every(w => c.allowWords.has(w) || PARTICLES.has(w))) return true
  }
  return false
}

/** Every private span in `text`, sorted, allowed ones dropped, overlaps merged. */
export function findSpans(text: string, c: Compiled): Span[] {
  const spans: Span[] = []
  if (!text || typeof text !== 'string') return spans
  const k = c.rules.kinds
  const used = new Uint8Array(text.length)
  if (c.denyRe) {
    customSpans(text, c, spans)
    for (const s of spans) take(used, s.a, s.b)
  }
  if (QUICK_RE.test(text)) {
    const before = spans.length
    if (k.secret) secretSpans(text, spans)
    for (let i = before; i < spans.length; i++) take(used, (spans[i] as Span).a, (spans[i] as Span).b)
    const emails: Span[] = []
    if (text.includes('@')) {
      emailSpans(text, emails)
      if (k.email) {
        for (const e of emails) {
          if (taken(used, e.a, e.b)) continue
          spans.push(e)
          take(used, e.a, e.b)
        }
      }
    }
    let inLink: Uint8Array | null = null
    if (text.includes('://') || text.includes('www.')) {
      inLink = new Uint8Array(text.length)
      URL_RE.lastIndex = 0
      for (const m of text.matchAll(URL_RE)) take(inLink, m.index ?? 0, (m.index ?? 0) + m[0].length)
    }
    if (k.number && /\d/.test(text)) numberSpans(text, spans, used, inLink)
    if (/[\d]/.test(text)) {
      if (k.amount) moneySpans(text, spans, used, inLink)
      if (k.phone) phoneSpans(text, spans, used, inLink)
    }
    if (k.path) {
      const at = spans.length
      pathSpans(text, spans)
      for (let i = at; i < spans.length; i++) take(used, (spans[i] as Span).a, (spans[i] as Span).b)
    }
    if (k.address) addressSpans(text, spans, used)
    if (/[:=]/.test(text)) keyedSpans(text, c, spans, used)
    if (k.name && c.rules.names !== 'off') nameSpans(text, c, spans, used, emails, inLink)
    tailSpan(text, c, spans)
  }
  const kept = spans.filter(s => !allowed(text, s, c))
  if (kept.length < 2) return kept
  kept.sort((x, y) => x.a - y.a || y.b - x.b)
  const out: Span[] = []
  for (const s of kept) {
    const prev = out[out.length - 1]
    if (prev && s.a < prev.b) {
      if (PRIORITY[s.kind] > PRIORITY[prev.kind]) prev.kind = s.kind
      if (s.b > prev.b) prev.b = s.b
    } else out.push({ ...s })
  }
  return out
}

// ------------------------------------------------------------------ drawing

const NOT_SPACE_RE = /\S/gu

/** A bar as long as `hit`: every character but a space becomes `glyph`. */
export function bar(hit: string, glyph = BAR) {
  return hit.replace(NOT_SPACE_RE, glyph)
}

const stars = (n: number) => '*'.repeat(Math.max(1, Math.min(n, 12)))

function partial(hit: string, kind: Kind): string {
  if (hit.length <= 3) return stars(hit.length)
  switch (kind) {
    case 'email': {
      const at = hit.lastIndexOf('@')
      const local = hit.slice(0, at)
      const domain = hit.slice(at + 1)
      const dot = domain.lastIndexOf('.')
      return `${local[0] ?? ''}***@${domain[0] ?? ''}***${dot >= 0 ? domain.slice(dot) : ''}`
    }
    case 'phone': {
      let left = 2
      let out = ''
      for (let i = hit.length - 1; i >= 0; i--) {
        const ch = hit[i] as string
        if (/\d/.test(ch)) {
          out = (left > 0 ? ch : '*') + out
          left--
        } else out = ch + out
      }
      return out
    }
    case 'amount':
      return hit.replace(/\d/g, '*')
    case 'number': {
      const digits = hit.replace(/[^\p{L}\p{N}]/gu, '')
      const tail = digits.slice(-4)
      return /^\d/.test(hit) && /[ -]/.test(hit) ? `${hit.slice(0, -4).replace(/\d/g, '*')}${tail}` : `${stars(Math.max(digits.length - 4, 4))}${tail}`
    }
    case 'secret': {
      const prefix = /^[A-Za-z]{2,6}[_-]/.exec(hit)?.[0] ?? ''
      return `${prefix}${stars(8)}`
    }
    default:
      // Names, paths, addresses and listed words: the first letter of each word.
      return hit
        .split(/(\s+)/)
        .map(w => (/^\s*$/.test(w) ? w : `${w[0] ?? ''}***`))
        .join('')
  }
}

/** What to draw in place of a hidden span. */
export function draw(hit: string, kind: Kind, style: Style, glyph = BAR): string {
  if (style === 'label') return `[${LABELS[kind]}]`
  if (style === 'partial') return partial(hit, kind)
  return bar(hit, glyph)
}

/** Rewrites every private span of `text` with `drawHit(hit, kind)`. Returns the same string when nothing is private. */
export function redact(text: string, c: Compiled, drawHit: (hit: string, kind: Kind) => string): string {
  if (!text || typeof text !== 'string') return text
  const spans = findSpans(text, c)
  if (spans.length === 0) return text
  let out = ''
  let at = 0
  for (const s of spans) {
    out += text.slice(at, s.a) + drawHit(text.slice(s.a, s.b), s.kind)
    at = s.b
  }
  return out + text.slice(at)
}

// A row draws again on every scroll and redraw, so a long text is masked once per setting and kept.
const cache = new Map<string, string>()
let cacheChars = 0
const CACHE_MIN = 120
const CACHE_MAX_CHARS = 4_000_000

export function clearCache() {
  cache.clear()
  cacheChars = 0
}

/** Hides every private span in one string, drawn as `c.rules.style` says. `glyph` overrides the bar glyph. */
export function maskText(text: string, c: Compiled, glyph?: string): string {
  if (!text || typeof text !== 'string') return text
  const g = glyph ?? c.rules.glyph
  const long = text.length >= CACHE_MIN
  const key = long ? `${c.key}\u0002${g}\u0002${text}` : ''
  if (long) {
    const hit = cache.get(key)
    if (hit !== undefined) return hit
  }
  const out = redact(text, c, (hit, kind) => draw(hit, kind, c.rules.style, g))
  if (long) {
    cacheChars += key.length + out.length
    cache.set(key, out)
    while (cacheChars > CACHE_MAX_CHARS) {
      const oldest = cache.entries().next().value
      if (!oldest) break
      cache.delete(oldest[0])
      cacheChars -= oldest[0].length + oldest[1].length
    }
  }
  return out
}

/** The whole text of a row as one placeholder, for when masking it failed. */
export function hiddenRow(text: unknown, glyph = BAR): string {
  const n = typeof text === 'string' ? Math.min(text.length, 40) : 12
  return `${glyph.repeat(Math.max(n, 6))} hidden by screen share`
}

/**
 * Masks every string inside plain data (a tool's input or result), keeping its shape and keys, so a
 * result still fits its tool's schema. A value under a key that names a private field (email,
 * phone, first_name, address, password) is hidden whole. Returns the same value when nothing changed.
 */
export function maskDeep<T>(value: T, c: Compiled, glyph?: string, depth = 0): T {
  const g = glyph ?? c.rules.glyph
  if (typeof value === 'string') return maskText(value, c, g) as T
  if (value === null || typeof value !== 'object') return value
  if (depth > 40) throw new Error('data nested too deep to mask')
  if (Array.isArray(value)) {
    let changed = false
    const out = value.map(v => {
      const m = maskDeep(v, c, g, depth + 1)
      if (m !== v) changed = true
      return m
    })
    return (changed ? out : value) as T
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value
  const entries = Object.entries(value as Record<string, unknown>)
  const hasEmail = entries.some(([k]) => EMAIL_KEY_RE.test(k))
  let changed = false
  const out: Record<string, unknown> = {}
  for (const [k, v] of entries) {
    let m: unknown = v
    if (SKIP_KEYS.has(k)) m = v
    else if (typeof v === 'string' && v) {
      const kind = keyKind(k) ?? (hasEmail && k === 'name' ? 'name' : undefined)
      if (kind && c.rules.kinds[kind] && !EMPTY_VALUE_RE.test(v) && !NOT_FIELD_VALUE_RE.test(v) && !NOT_SECRET_VALUE.test(v)) m = draw(v, kind, c.rules.style, g)
      else m = maskText(v, c, g)
    } else m = maskDeep(v, c, g, depth + 1)
    if (m !== v) changed = true
    out[k] = m
  }
  return (changed ? out : value) as T
}

/** True when `text` still holds something the rules would hide (a self-check for tests). */
export function leaks(text: string, c: Compiled): boolean {
  return findSpans(text, c).length > 0
}

// Run every rule once at load, so the first row drawn after /screen-share on does not pay for building the patterns.
try {
  maskText('From: Jane Doe <jane@x.co> (Bob Lee) | +44 7700 900123, $4,250.00, token=abcdef123456, 4111 1111 1111 1111 /Users/me/x', compile(DEFAULT_RULES))
  clearCache()
} catch {
  // The first real call will say what is wrong.
}
