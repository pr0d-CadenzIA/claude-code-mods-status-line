/** One rate-limit window of the subscription, as the last API response reported it. */
export type UsageWindow = {
  /** `five_hour`, `seven_day`, or a gateway's `spend_limit`. */
  kind: string
  /** 0 to 100. */
  percentUsed: number
  /** ISO 8601. */
  resetsAt?: string
}

/** What this session measured last: cost and context fill. */
export type UsageSnapshot = {
  costUsd: number | null
  contextTokens: number | null
  contextWindow: number | null
  contextPercent: number | null
}

/** The freshest reading of the account's windows, from this session or another one. */
export type LimitsReading = {
  windows: UsageWindow[]
  /** When the reading was taken, in ms since the epoch. */
  readAt: number
  /** False when the reading came from another session (shared file). */
  isFromThisSession: boolean
}

export type SessionMeta = {
  model: string | null
  turns: number
  startedAt: number | null
}

/** What every session spent today, summed from the shared ledger. */
export type DayTotal = {
  day: string
  usd: number
  sessions: number
}

declare module 'claude-code' {
  interface PluginState {
    'barre-usage': {
      snapshot: Shaped<UsageSnapshot | null>
      limits: Shaped<LimitsReading | null>
      meta: Shaped<SessionMeta | null>
      today: Shaped<DayTotal | null>
      now: number
      problem: string | null
      /** The detail row under the line, opened with the gear. */
      isExpanded: boolean
    }
  }
}
