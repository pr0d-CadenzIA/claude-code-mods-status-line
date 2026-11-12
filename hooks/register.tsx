import { atom, read, update } from 'claude-code'
import type {
  Elements,
  EngineInterface,
  Register,
  SessionContextUsage,
  SessionCost,
  SessionRateLimit,
  StateDollar,
} from 'claude-code'

import type {
  DayTotal,
  LimitsReading,
  SessionMeta,
  UsageSnapshot,
  UsageWindow,
} from '../types'

// ---------------------------------------------------------------------------
// State the band draws from. Shape tags: bump one when its value's fields
// change, so a hot reload declines what the older code stored.
// ---------------------------------------------------------------------------

const snapshotState = atom({ plugin: 'barre-usage', key: 'snapshot' } as const, null, {
  shape: 'snapshot-1',
})
const limitsState = atom({ plugin: 'barre-usage', key: 'limits' } as const, null, {
  shape: 'limits-1',
})
const metaState = atom({ plugin: 'barre-usage', key: 'meta' } as const, null, {
  shape: 'meta-1',
})
const todayState = atom({ plugin: 'barre-usage', key: 'today' } as const, null, {
  shape: 'today-1',
})
const nowState = atom({ plugin: 'barre-usage', key: 'now' } as const, 0)
const problemState = atom({ plugin: 'barre-usage', key: 'problem' } as const, null)
const expandedState = atom({ plugin: 'barre-usage', key: 'isExpanded' } as const, false)

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** Ledger files older than this are not read when summing today's spend. */
const LEDGER_RECENT_MS = 36 * HOUR
/** A reading of the windows older than this is labelled with its age. */
const STALE_READING_MS = 15 * MINUTE
/** `$.store` key: whether the detail row is open, kept across sessions. */
const EXPANDED_STORE_KEY = 'isExpanded'

const WINDOW_LENGTH_MS: Record<string, number> = {
  five_hour: 5 * HOUR,
  seven_day: 7 * DAY,
}
const WINDOW_ORDER = ['five_hour', 'seven_day']
const WINDOW_LABEL: Record<string, string> = {
  five_hour: '5h',
  seven_day: 'Sem.',
  spend_limit: 'Plafond',
}

/** Mid-tone colors that read on both light and dark backgrounds. */
const COLORS = {
  pill: '#3B7BF0',
  green: '#22C55E',
  amber: '#EAB308',
  red: '#EF4444',
  neutral: '#8C8C8C',
}

const PILL_WIDTH = 92
const PILL_HEIGHT = 20
const MINI_BAR_WIDTH = 52
const MINI_BAR_HEIGHT = 7
const TERMINAL_BAR_CELLS = 6

const FALLBACK_TIME_ZONE = 'Europe/Paris'
const WEEKDAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEKDAYS_FR = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.']

// ---------------------------------------------------------------------------
// Time and number formatting
// ---------------------------------------------------------------------------

/** The machine's zone when the plugin environment knows it, Lyon's otherwise. */
function detectTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const isUsable = typeof zone === 'string' && zone !== '' && zone !== 'UTC' && zone !== 'Etc/UTC'
    return isUsable ? zone : FALLBACK_TIME_ZONE
  } catch {
    return FALLBACK_TIME_ZONE
  }
}

const TIME_ZONE = detectTimeZone()

type ClockParts = {
  year: string
  month: string
  day: string
  weekday: number
  hour: string
  minute: string
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function clockParts(epochMs: number): ClockParts {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: TIME_ZONE,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date(epochMs))
    const partOf = (type: string) => parts.find(part => part.type === type)?.value ?? ''
    return {
      year: partOf('year'),
      month: partOf('month'),
      day: partOf('day'),
      weekday: WEEKDAYS_EN.indexOf(partOf('weekday')),
      hour: partOf('hour'),
      minute: partOf('minute'),
    }
  } catch {
    // No Intl time zone data in this environment: fall back to the local clock.
    const date = new Date(epochMs)
    return {
      year: String(date.getFullYear()),
      month: pad2(date.getMonth() + 1),
      day: pad2(date.getDate()),
      weekday: date.getDay(),
      hour: pad2(date.getHours()),
      minute: pad2(date.getMinutes()),
    }
  }
}

/** `2026-11-12` in the person's zone: the key of the daily ledger. */
function dayKey(epochMs: number): string {
  const parts = clockParts(epochMs)
  return `${parts.year}-${parts.month}-${parts.day}`
}

/** `14:35` today, `demain 09:00`, otherwise `jeu. 09:00`. */
function formatWhen(epochMs: number, now: number): string {
  const parts = clockParts(epochMs)
  const time = `${parts.hour}:${parts.minute}`
  if (dayKey(epochMs) === dayKey(now)) return time
  if (dayKey(epochMs) === dayKey(now + DAY)) return `demain ${time}`
  const weekday = WEEKDAYS_FR[parts.weekday] ?? `${parts.day}/${parts.month}`
  return `${weekday} ${time}`
}

/** Compact, for the line: `45min`, `2h10`, `1j20h`, `3j`. */
function formatRemaining(durationMs: number): string {
  const totalMinutes = Math.max(0, Math.round(durationMs / MINUTE))
  if (totalMinutes < 60) return `${totalMinutes}min`
  const totalHours = Math.floor(totalMinutes / 60)
  if (totalHours < 24) return `${totalHours}h${pad2(totalMinutes % 60)}`
  const days = Math.floor(totalHours / 24)
  return days >= 2 ? `${days}j` : `${days}j${totalHours % 24}h`
}

/** For the detail row: `12min`, `1h05`, `2j3h`. */
function formatDuration(durationMs: number): string {
  const totalMinutes = Math.max(0, Math.round(durationMs / MINUTE))
  if (totalMinutes < 60) return `${totalMinutes}min`
  const totalHours = Math.floor(totalMinutes / 60)
  if (totalHours < 24) return `${totalHours}h${pad2(totalMinutes % 60)}`
  return `${Math.floor(totalHours / 24)}j${totalHours % 24}h`
}

/** `$4.88`, `$1,204`. */
function formatUsd(amount: number): string {
  const decimals = amount >= 1000 ? 0 : 2
  const [integerPart = '0', fractionPart] = amount.toFixed(decimals).split('.')
  const grouped = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return fractionPart === undefined ? `$${grouped}` : `$${grouped}.${fractionPart}`
}

/** `66%`, `7.5%`. */
function formatPercent(percent: number): string {
  const isSmallFraction = percent < 10 && !Number.isInteger(percent)
  return `${isSmallFraction ? percent.toFixed(1) : String(Math.round(percent))}%`
}

/** `133k`, `1M`, `1.2M`. */
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000
    const text = millions >= 10 || Number.isInteger(millions) ? String(Math.round(millions)) : millions.toFixed(1)
    return `${text}M`
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`
  return String(tokens)
}

/** `claude-opus-5-5` reads `Opus 5.5`; anything unrecognised is shown as given. */
function prettyModel(rawModel: string | null): string | null {
  if (!rawModel) return null
  const match = /(opus|sonnet|haiku|fable)[-_ ]?(\d+)(?:[-_.](\d+))?/i.exec(rawModel)
  const [, familyName, major, minor] = match ?? []
  if (!familyName || !major) return rawModel.charAt(0).toUpperCase() + rawModel.slice(1)
  const family = familyName.charAt(0).toUpperCase() + familyName.slice(1).toLowerCase()
  return minor ? `${family} ${major}.${minor}` : `${family} ${major}`
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count > 1 ? pluralForm : singular}`
}

// ---------------------------------------------------------------------------
// Rate-limit windows: where the person stands, and where the pace leads
// ---------------------------------------------------------------------------

type Level = 'ok' | 'warn' | 'alert'

function levelOf(percent: number, warnAt: number, alertAt: number): Level {
  if (percent >= alertAt) return 'alert'
  if (percent >= warnAt) return 'warn'
  return 'ok'
}

const LEVEL_HEX: Record<Level, string> = { ok: COLORS.green, warn: COLORS.amber, alert: COLORS.red }

type WindowView = {
  kind: string
  percent: number
  resetsAt: number | null
  hasReset: boolean
  /** Where a perfectly even pace would stand now, 0 to 100. */
  evenPacePercent: number | null
  /** Where the window ends at the average pace so far, when that stays under 100. */
  projectedPercent: number | null
  /** When the window fills at the average pace so far, when that comes before its reset. */
  fullAt: number | null
}

function analyseWindow(window: UsageWindow, now: number): WindowView {
  const lengthMs = WINDOW_LENGTH_MS[window.kind] ?? null
  const parsedReset = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN
  const resetsAt = Number.isFinite(parsedReset) ? parsedReset : null
  const hasReset = resetsAt !== null && resetsAt <= now
  const percent = hasReset ? 0 : window.percentUsed

  let evenPacePercent: number | null = null
  let projectedPercent: number | null = null
  let fullAt: number | null = null

  if (lengthMs !== null && resetsAt !== null && !hasReset) {
    const windowStart = resetsAt - lengthMs
    const elapsedMs = Math.min(lengthMs, Math.max(0, now - windowStart))
    const elapsedFraction = elapsedMs / lengthMs
    evenPacePercent = elapsedFraction * 100

    // Too early in the window, a projection is noise: wait for 8 % of it.
    if (elapsedFraction >= 0.08 && percent > 0) {
      const projected = percent / elapsedFraction
      if (projected >= 100) {
        const percentPerMs = percent / elapsedMs
        const candidate = now + (100 - percent) / percentPerMs
        fullAt = candidate < resetsAt ? candidate : null
      } else {
        projectedPercent = projected
      }
    }
  }

  return { kind: window.kind, percent, resetsAt, hasReset, evenPacePercent, projectedPercent, fullAt }
}

function sortWindows(windows: UsageWindow[]): UsageWindow[] {
  const rank = (kind: string) => {
    const index = WINDOW_ORDER.indexOf(kind)
    return index === -1 ? WINDOW_ORDER.length : index
  }
  return [...windows].sort((left, right) => rank(left.kind) - rank(right.kind))
}

// ---------------------------------------------------------------------------
// What the band shows, independent of the surface
// ---------------------------------------------------------------------------

type BandData = {
  snapshot: UsageSnapshot | null
  limits: LimitsReading | null
  meta: SessionMeta | null
  today: DayTotal | null
  now: number
  problem: string | null
  isExpanded: boolean
}

type ContextView = {
  /** `133k/200k`, or `—` before the first exchange. */
  text: string
  percent: number
  fillHex: string
  level: Level
}

type GaugeView = {
  id: string
  label: string
  percent: number
  percentText: string
  level: Level
  /**
   * Even pace minus what is used: `+5.2%` is room in hand, `-13.6%` is ahead
   * of a steady pace (the window fills early if it keeps up).
   */
  marginText: string | null
  marginLevel: Level
  remainingText: string | null
}

type BandView = {
  context: ContextView
  costText: string
  gauges: GaugeView[]
  details: string[]
  problem: string | null
}

function contextView(data: BandData): ContextView {
  const percent = data.snapshot?.contextPercent ?? null
  const tokens = data.snapshot?.contextTokens ?? null
  const windowSize = data.snapshot?.contextWindow ?? null
  const sizeText = windowSize ? formatTokens(windowSize) : '?'
  if (percent === null || tokens === null) {
    return { text: `—/${sizeText}`, percent: 0, fillHex: COLORS.pill, level: 'ok' }
  }
  const level = levelOf(percent, 80, 90)
  const fillHex = level === 'ok' ? COLORS.pill : LEVEL_HEX[level]
  return { text: `${formatTokens(tokens)}/${sizeText}`, percent, fillHex, level }
}

function gaugeView(window: UsageWindow, now: number): GaugeView {
  const view = analyseWindow(window, now)
  let marginText: string | null = null
  let marginLevel: Level = 'ok'
  if (view.evenPacePercent !== null) {
    // Whole points: room on one line matters more than the decimal.
    const margin = Math.round(view.evenPacePercent - view.percent)
    marginText = `${margin >= 0 ? '+' : '-'}${Math.abs(margin)}%`
    marginLevel = margin >= 0 ? 'ok' : margin > -10 ? 'warn' : 'alert'
  }
  let remainingText: string | null = null
  if (view.hasReset) remainingText = 'reset'
  else if (view.resetsAt !== null) remainingText = formatRemaining(view.resetsAt - now)
  return {
    id: `window-${view.kind}`,
    label: WINDOW_LABEL[view.kind] ?? view.kind,
    percent: view.percent,
    percentText: formatPercent(view.percent),
    level: levelOf(view.percent, 50, 80),
    marginText,
    marginLevel,
    remainingText,
  }
}

/** The detail row: today's spend, the hourly rate, the projections, the session. */
function detailChips(data: BandData): string[] {
  const chips: string[] = []
  if (data.today && data.today.usd > 0) {
    chips.push(`Aujourd'hui ${formatUsd(data.today.usd)} (${plural(data.today.sessions, 'session', 'sessions')})`)
  }
  const cost = data.snapshot?.costUsd ?? null
  const startedAt = data.meta?.startedAt ?? null
  if (cost !== null && cost > 0 && startedAt !== null && data.now - startedAt >= 15 * MINUTE) {
    chips.push(`≈ ${formatUsd(cost / ((data.now - startedAt) / HOUR))}/h`)
  }
  if (data.limits) {
    for (const window of sortWindows(data.limits.windows)) {
      const view = analyseWindow(window, data.now)
      const label = WINDOW_LABEL[view.kind] ?? view.kind
      const resetText = view.resetsAt !== null && !view.hasReset ? `reset ${formatWhen(view.resetsAt, data.now)}` : null
      let paceText: string | null = null
      if (view.fullAt !== null) paceText = `plein ${formatWhen(view.fullAt, data.now)} à ce rythme`
      else if (view.projectedPercent !== null) paceText = `${formatPercent(view.projectedPercent)} au reset à ce rythme`
      const parts = [resetText, paceText].filter((text): text is string => text !== null)
      if (parts.length > 0) chips.push(`${label} ${parts.join(', ')}`)
    }
    const ageMs = data.now - data.limits.readAt
    if (!data.limits.isFromThisSession) chips.push(`limites relevées par une autre session il y a ${formatDuration(ageMs)}`)
    else if (ageMs >= STALE_READING_MS) chips.push(`limites relevées il y a ${formatDuration(ageMs)}`)
  } else {
    chips.push('limites 5h et semaine : au 1er échange')
  }
  const model = prettyModel(data.meta?.model ?? null)
  const session = [
    model,
    startedAt === null ? null : formatDuration(data.now - startedAt),
    data.meta ? plural(data.meta.turns, 'message', 'messages') : null,
  ].filter((text): text is string => text !== null)
  if (session.length > 0) chips.push(session.join(' · '))
  if (data.problem) chips.push(`⚠ ${data.problem}`)
  return chips
}

function buildView(data: BandData): BandView {
  const cost = data.snapshot?.costUsd ?? null
  return {
    context: contextView(data),
    costText: cost === null ? '$—' : formatUsd(cost),
    gauges: data.limits ? sortWindows(data.limits.windows).map(window => gaugeView(window, data.now)) : [],
    details: detailChips(data),
    problem: data.problem,
  }
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** The context pill: a rounded gauge with `133k/200k` written across it. */
function pillSvg(context: ContextView): string {
  const radius = PILL_HEIGHT / 2
  const clamped = Math.min(100, Math.max(0, context.percent))
  const fillWidth = clamped === 0 ? 0 : Math.max(PILL_HEIGHT, Math.round((PILL_WIDTH * clamped) / 100))
  const fill =
    fillWidth === 0
      ? ''
      : `<rect x="0" y="0" width="${fillWidth}" height="${PILL_HEIGHT}" rx="${radius}" fill="url(#pill)"/>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PILL_WIDTH}" height="${PILL_HEIGHT}" viewBox="0 0 ${PILL_WIDTH} ${PILL_HEIGHT}">` +
    `<defs><linearGradient id="pill" x1="0" y1="0" x2="1" y2="0">` +
    `<stop offset="0" stop-color="${context.fillHex}" stop-opacity="0.8"/><stop offset="1" stop-color="${context.fillHex}"/>` +
    `</linearGradient></defs>` +
    `<rect x="0" y="0" width="${PILL_WIDTH}" height="${PILL_HEIGHT}" rx="${radius}" fill="${COLORS.neutral}" fill-opacity="0.28"/>` +
    fill +
    // White text with a soft dark outline: readable over the fill and the track, in both themes.
    `<text x="${PILL_WIDTH / 2}" y="${PILL_HEIGHT / 2}" dominant-baseline="central" text-anchor="middle" ` +
    `font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif" font-size="12" font-weight="700" ` +
    `fill="#FFFFFF" stroke="#000000" stroke-opacity="0.35" stroke-width="2" paint-order="stroke">` +
    `${escapeXml(context.text)}</text>` +
    `</svg>`
  )
}

/** A short rounded gauge for a rate-limit window. */
function miniBarSvg(percent: number, hex: string): string {
  const radius = MINI_BAR_HEIGHT / 2
  const clamped = Math.min(100, Math.max(0, percent))
  const fillWidth = clamped === 0 ? 0 : Math.max(MINI_BAR_HEIGHT, Math.round((MINI_BAR_WIDTH * clamped) / 100))
  const fill =
    fillWidth === 0
      ? ''
      : `<rect x="0" y="0" width="${fillWidth}" height="${MINI_BAR_HEIGHT}" rx="${radius}" fill="${hex}"/>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${MINI_BAR_WIDTH}" height="${MINI_BAR_HEIGHT}" viewBox="0 0 ${MINI_BAR_WIDTH} ${MINI_BAR_HEIGHT}">` +
    `<rect x="0" y="0" width="${MINI_BAR_WIDTH}" height="${MINI_BAR_HEIGHT}" rx="${radius}" fill="${COLORS.neutral}" fill-opacity="0.28"/>` +
    fill +
    `</svg>`
  )
}

function desktopTree($: StateDollar & Pick<EngineInterface, 'store'>, view: BandView, isExpanded: boolean, elements: Elements['desktop']) {
  const { Box, Text, Svg, Button } = elements
  return (
    <Box flexDirection="column" rowGap="xs" paddingX="sm">
      <Box flexDirection="row" flexWrap="nowrap" alignItems="center" columnGap="md" overflow="hidden">
        <Box key="session" flexDirection="row" flexShrink={0} alignItems="center" columnGap="xs">
          <Text dimColor>S</Text>
          <Svg
            source={pillSvg(view.context)}
            alt={`Contexte ${view.context.text}`}
            width={PILL_WIDTH}
            height={PILL_HEIGHT}
          />
          <Text weight="semibold" tabular>
            {view.costText}
          </Text>
        </Box>
        {view.gauges.map(gauge => (
          <Box key={gauge.id} flexDirection="row" flexShrink={0} alignItems="center" columnGap="xs">
            <Text dimColor>{gauge.label}</Text>
            <Svg
              source={miniBarSvg(gauge.percent, LEVEL_HEX[gauge.level])}
              alt={`${gauge.label} ${gauge.percentText}`}
              width={MINI_BAR_WIDTH}
              height={MINI_BAR_HEIGHT}
            />
            <Text weight="semibold" tabular>
              {gauge.percentText}
            </Text>
            {gauge.marginText ? (
              <Text tabular color={LEVEL_HEX[gauge.marginLevel]}>
                {gauge.marginText}
              </Text>
            ) : null}
            {gauge.remainingText ? (
              <Text dimColor tabular>
                {gauge.remainingText}
              </Text>
            ) : null}
          </Box>
        ))}
        {view.problem ? <Text color={COLORS.amber}>⚠</Text> : null}
        <Button
          key="details"
          plain
          label="⚙"
          onPress={async () => {
            const isOpen = await update($, expandedState, value => !value)
            await $.store.set(EXPANDED_STORE_KEY, isOpen)
          }}
        />
      </Box>
      {isExpanded ? (
        <Text size="footnote" dimColor wrap="truncate-end">
          {view.details.join('  ·  ')}
        </Text>
      ) : null}
    </Box>
  )
}

type Tone = Level | 'muted' | 'plain' | 'accent'
type Part = { text: string; tone: Tone }
/** One stretch of the terminal line; the highest `dropOrder` goes first when room runs out. */
type Segment = { id: string; dropOrder: number; parts: Part[] }

function terminalBar(percent: number, level: Level): Part[] {
  const filled = Math.min(TERMINAL_BAR_CELLS, Math.max(0, Math.round((percent / 100) * TERMINAL_BAR_CELLS)))
  return [
    { text: '━'.repeat(filled), tone: level },
    { text: '─'.repeat(TERMINAL_BAR_CELLS - filled), tone: 'muted' },
  ]
}

function buildSegments(view: BandView): Segment[] {
  const segments: Segment[] = [
    {
      id: 'session',
      dropOrder: 0,
      parts: [
        { text: 'S ', tone: 'muted' },
        { text: view.context.text, tone: view.context.level === 'ok' ? 'accent' : view.context.level },
        { text: ` ${view.costText}`, tone: 'plain' },
      ],
    },
  ]
  view.gauges.forEach((gauge, index) => {
    const parts: Part[] = [
      { text: `${gauge.label} `, tone: 'muted' },
      ...terminalBar(gauge.percent, gauge.level),
      { text: ` ${gauge.percentText}`, tone: 'plain' },
    ]
    if (gauge.marginText) parts.push({ text: ` ${gauge.marginText}`, tone: gauge.marginLevel })
    if (gauge.remainingText) parts.push({ text: ` ${gauge.remainingText}`, tone: 'muted' })
    segments.push({ id: gauge.id, dropOrder: 1 + index, parts })
  })
  if (view.problem) segments.push({ id: 'problem', dropOrder: 9, parts: [{ text: '⚠', tone: 'warn' }] })
  return segments
}

const SEPARATOR = '   '

function textWidth(text: string): number {
  return [...text].length
}

/** Drops the least important segments until the line fits the band. */
function fitSegments(segments: Segment[], columns: number): Segment[] {
  const kept = [...segments]
  const lineWidth = () =>
    kept.reduce((sum, segment) => sum + segment.parts.reduce((width, part) => width + textWidth(part.text), 0), 0) +
    Math.max(0, kept.length - 1) * SEPARATOR.length
  while (kept.length > 1 && lineWidth() > columns) {
    let dropIndex = 0
    kept.forEach((segment, index) => {
      if (segment.dropOrder > (kept[dropIndex]?.dropOrder ?? -1)) dropIndex = index
    })
    kept.splice(dropIndex, 1)
  }
  return kept
}

function themeKeyOf(tone: Tone): 'success' | 'warning' | 'error' | 'suggestion' | undefined {
  switch (tone) {
    case 'ok':
      return 'success'
    case 'warn':
      return 'warning'
    case 'alert':
      return 'error'
    case 'accent':
      return 'suggestion'
    default:
      return undefined
  }
}

function terminalTree(view: BandView, columns: number, elements: Elements['terminal']) {
  const { Box, Text } = elements
  const visible = fitSegments(buildSegments(view), columns)
  const children = visible.flatMap((segment, index) => {
    const parts = segment.parts.map(part => (
      <Text color={themeKeyOf(part.tone)} dimColor={part.tone === 'muted'} bold={part.tone === 'plain'}>
        {part.text}
      </Text>
    ))
    return index === 0 ? parts : [<Text>{SEPARATOR}</Text>, ...parts]
  })
  return (
    <Box flexDirection="row" flexWrap="nowrap">
      {children}
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Measuring, and the files every session shares
// ---------------------------------------------------------------------------

let cachedDataDir: string | null = null

/** `~/.claude/barre-usage`, or under `CLAUDE_CONFIG_DIR` when it is set. */
async function dataDirOf($: EngineInterface): Promise<string> {
  if (cachedDataDir) return cachedDataDir
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  if (configDir) {
    cachedDataDir = `${configDir.replace(/\/+$/, '')}/barre-usage`
    return cachedDataDir
  }
  const home = await $.env.get('HOME')
  if (!home) throw new Error('HOME introuvable : relevés partagés indisponibles')
  cachedDataDir = `${home.replace(/\/+$/, '')}/.claude/barre-usage`
  return cachedDataDir
}

async function readJsonFile($: EngineInterface, path: string): Promise<unknown> {
  if (!(await $.fs.exists(path))) return undefined
  const text = await $.fs.read(path)
  try {
    return JSON.parse(text)
  } catch {
    // Caught mid-write by another session: the next minute reads it whole.
    return undefined
  }
}

type LedgerEntry = { day: string; startUsd: number; usd: number; updatedAt: number }

function parseLedgerEntry(value: unknown): LedgerEntry | null {
  if (typeof value !== 'object' || value === null) return null
  const fields = value as Record<string, unknown>
  const isValid =
    typeof fields.day === 'string' &&
    typeof fields.startUsd === 'number' &&
    typeof fields.usd === 'number' &&
    typeof fields.updatedAt === 'number'
  if (!isValid) return null
  return {
    day: fields.day as string,
    startUsd: fields.startUsd as number,
    usd: fields.usd as number,
    updatedAt: fields.updatedAt as number,
  }
}

function parseWindows(value: unknown): UsageWindow[] | null {
  if (!Array.isArray(value)) return null
  const windows: UsageWindow[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const fields = item as Record<string, unknown>
    if (typeof fields.kind !== 'string' || typeof fields.percentUsed !== 'number') continue
    windows.push({
      kind: fields.kind,
      percentUsed: fields.percentUsed,
      resetsAt: typeof fields.resetsAt === 'string' ? fields.resetsAt : undefined,
    })
  }
  return windows
}

function toWindow(rateLimit: SessionRateLimit): UsageWindow {
  return rateLimit.resetsAt === undefined
    ? { kind: rateLimit.kind, percentUsed: rateLimit.percentUsed }
    : { kind: rateLimit.kind, percentUsed: rateLimit.percentUsed, resetsAt: rateLimit.resetsAt }
}

function sessionFileName(sessionId: string): string {
  return `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`
}

/**
 * Values are written only when they differ, so a quiet minute redraws nothing.
 * (The state scan wants each atom named at its call site: no generic helper.)
 */
function isSame(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function setProblem($: StateDollar, problem: string | null): Promise<void> {
  if (isSame(await read($, problemState), problem)) return
  await update($, problemState, () => problem)
}

/**
 * Keeps this session's spend in its own ledger file: `startUsd` is what the
 * session had cost when the day began (or when the bar first saw it), so
 * `usd - startUsd` is what it spent today.
 */
async function recordCost($: EngineInterface, usd: number, previousUsd: number | null, now: number): Promise<void> {
  const sessionId = await $.session.id()
  const path = `${await dataDirOf($)}/sessions/${sessionFileName(sessionId)}`
  const stored = parseLedgerEntry(await readJsonFile($, path))
  const today = dayKey(now)

  let entry: LedgerEntry
  if (stored && stored.day === today) {
    if (stored.usd === usd) return
    entry = { day: today, startUsd: usd < stored.startUsd ? 0 : stored.startUsd, usd, updatedAt: now }
  } else if (stored) {
    // A new day for a session that already spent: yesterday's total is today's base.
    entry = { day: today, startUsd: usd < stored.usd ? 0 : stored.usd, usd, updatedAt: now }
  } else {
    if (usd <= 0) return
    let base: number
    if (previousUsd !== null) {
      // Same process under a new id (after /clear): count only what is new.
      base = usd < previousUsd ? 0 : previousUsd
    } else {
      // First sight of a resumed session: what it cost on earlier days is not today's.
      const { startedAt } = await $.session.usage()
      base = dayKey(startedAt) === today ? 0 : usd
    }
    entry = { day: today, startUsd: base, usd, updatedAt: now }
  }
  await $.fs.write(path, JSON.stringify(entry))
}

/** Sums today's spend over every session's ledger file. */
async function refreshToday($: EngineInterface, now: number): Promise<void> {
  const directory = `${await dataDirOf($)}/sessions`
  const today = dayKey(now)
  let usd = 0
  let sessions = 0
  if (await $.fs.exists(directory)) {
    for (const file of await $.fs.list(directory)) {
      if (file.kind !== 'file' || !file.name.endsWith('.json')) continue
      if (now - file.mtimeMs > LEDGER_RECENT_MS) continue
      const entry = parseLedgerEntry(await readJsonFile($, `${directory}/${file.name}`))
      if (!entry || entry.day !== today) continue
      const spent = Math.max(0, entry.usd - entry.startUsd)
      if (spent >= 0.005) {
        usd += spent
        sessions += 1
      }
    }
  }
  const total: DayTotal = { day: today, usd: Math.round(usd * 100) / 100, sessions }
  if (isSame(await read($, todayState), total)) return
  await update($, todayState, () => total)
}

/** Takes the windows another session read, when they are fresher than this one's. */
async function adoptSharedLimits($: EngineInterface): Promise<void> {
  const shared = await readJsonFile($, `${await dataDirOf($)}/limits.json`)
  if (typeof shared !== 'object' || shared === null) return
  const fields = shared as Record<string, unknown>
  const windows = parseWindows(fields.windows)
  if (!windows || windows.length === 0 || typeof fields.readAt !== 'number') return
  const current = await read($, limitsState)
  if (current && current.readAt >= fields.readAt) return
  await update($, limitsState, () => ({ windows, readAt: fields.readAt as number, isFromThisSession: false }))
}

type Measurement = {
  context: SessionContextUsage
  rateLimits: SessionRateLimit[]
  cost?: SessionCost
}

async function absorbMeasurement($: EngineInterface, measurement: Measurement, now: number): Promise<void> {
  const previous = await read($, snapshotState)
  const snapshot: UsageSnapshot = {
    costUsd: measurement.cost?.usd ?? null,
    contextTokens: measurement.context.tokens ?? null,
    contextWindow: measurement.context.window > 0 ? measurement.context.window : null,
    contextPercent: measurement.context.percent ?? null,
  }
  if (!isSame(previous, snapshot)) await update($, snapshotState, () => snapshot)

  if (measurement.rateLimits.length > 0) {
    const windows = measurement.rateLimits.map(toWindow)
    await update($, limitsState, () => ({ windows, readAt: now, isFromThisSession: true }))
    await $.fs.write(`${await dataDirOf($)}/limits.json`, JSON.stringify({ windows, readAt: now }))
  }

  if (measurement.cost) {
    await recordCost($, measurement.cost.usd, previous?.costUsd ?? null, now)
  }
}

async function refreshMeta($: EngineInterface): Promise<void> {
  const [model, turns, usage] = await Promise.all([$.session.model(), $.session.turns(), $.session.usage()])
  const meta: SessionMeta = { model, turns, startedAt: usage.startedAt }
  if (isSame(await read($, metaState), meta)) return
  await update($, metaState, () => meta)
}

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 120 ? `${text.slice(0, 117)}...` : text
}

/** Runs a piece of background work; a failure shows in the band instead of vanishing. */
async function guarded($: EngineInterface, work: () => Promise<void>): Promise<void> {
  try {
    await work()
    await setProblem($, null)
  } catch (error) {
    await setProblem($, messageOf(error))
  }
}

async function tick($: EngineInterface): Promise<void> {
  await guarded($, async () => {
    const now = await $.clock.now()
    await update($, nowState, () => now)
    await adoptSharedLimits($)
    await refreshToday($, now)
  })
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    cachedDataDir = null
    await guarded($, async () => {
      const storedExpanded = await $.store.get(EXPANDED_STORE_KEY)
      await update($, expandedState, () => storedExpanded === true)
      const now = await $.clock.now()
      await update($, nowState, () => now)
      const usage = await $.session.usage()
      await refreshMeta($)
      await absorbMeasurement($, usage, now)
      await adoptSharedLimits($)
      await refreshToday($, now)
    })
    // Countdowns and the other sessions' spend move on their own: look every minute.
    $.clock.every(MINUTE, () => {
      void tick($)
    })
    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    await guarded($, async () => {
      const now = await $.clock.now()
      await update($, nowState, () => now)
      await absorbMeasurement($, { context: e.context, rateLimits: e.rateLimits, cost: e.cost }, now)
      await refreshMeta($)
      await refreshToday($, now)
    })
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const data: BandData = {
      snapshot: await read($, snapshotState),
      limits: await read($, limitsState),
      meta: await read($, metaState),
      today: await read($, todayState),
      now: await read($, nowState),
      problem: await read($, problemState),
      isExpanded: await read($, expandedState),
    }
    const view = buildView(data)

    if (e.surface === 'desktop') {
      return desktopTree($, view, data.isExpanded, $.ui.resolve(e))
    }
    if (e.surface === 'terminal') {
      return terminalTree(view, e.props.bodyColumns, $.ui.resolve(e))
    }
    return next(e)
  })
}
