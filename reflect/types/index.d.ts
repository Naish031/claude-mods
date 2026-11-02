export type ReflectScope = 'everywhere' | 'project' | 'vault'

export type ReflectBand = {
  /**
   * offer: the rule and the scope buttons. edit: the rule in a text field.
   * confirm: the exact text that will be written, and Write it. saved: one line with Open and Undo.
   */
  phase: 'offer' | 'edit' | 'confirm' | 'saved'
  /** Changes with every new band, so an old timer never clears a newer one. */
  id: number
  /** The drafted (or edited) rule, one line. */
  rule: string
  /** 2 to 6 words, kebab-case, for the vault file name. */
  slug: string
  /** One of writing, code, style, process, tools, communication, other. */
  category: string
  /** Up to 3 short kebab-case tags. */
  tags: string[]
  /** The person's correction, secrets cut out, one line, 200 characters at most. */
  correction: string
  /** The name (not the path) of the folder the chat ran in. */
  learnedIn: string
  /** The scope the draft looks best suited to. */
  hint: 'everywhere' | 'project'
  /** Whether Save to project is offered: the chat runs in a folder that is not the home folder. */
  canProject: boolean
  /** The scope picked in the offer (confirm and saved). */
  scope: ReflectScope | ''
  /** Absolute path that will be, or was, written (confirm and saved). */
  target: string
  /** The same path with ~ for the home folder. */
  shortTarget: string
  /** The exact text that will be added (confirm). */
  preview: string
  /** A fingerprint of the file as it was when the text was shown, so a change in between is noticed (confirm). */
  baseKey: string
  /** True when the file does not exist yet and will be created (confirm). */
  isCreate: boolean
  /** The journal entry of what was saved, for Undo (saved). */
  entryId: string
  /** What the saved line says: Saved to, Already saved in, Removed from. */
  verb: string
  /** A line under the buttons. */
  note: string
  isError: boolean
}

export type ReflectChat = {
  /** The person pressed Not for this chat. */
  muted: boolean
  /** When the last offer was shown, ms since the epoch, 0 for never. */
  lastOfferAt: number
  /** Offers skipped in a row; each one doubles the quiet time. */
  skipStreak: number
  /** Normalised rules skipped in this chat, so the same one is not offered again. */
  skipped: string[]
  /** Files backed up in this chat, so each is copied once. */
  backedUp: string[]
}

declare module 'claude-code' {
  interface PluginState {
    reflect: { band: Shaped<ReflectBand | null>; chat: Shaped<ReflectChat> }
  }
}
