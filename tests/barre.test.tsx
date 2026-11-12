import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
// Thursday 12 November 2026, 10:00 in Paris (09:00 UTC).
const NOW = Date.UTC(2026, 10, 12, 9, 0, 0)
const HOME = '/home/test'
const DATA = `${HOME}/.claude/barre-usage`

const BAND = {
  plugin: 'barre-usage',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 150,
    scroll: { offset: 0, bodyRows: 11 },
    view: {},
  },
} as const

type Files = Map<string, string>

/** A file system in memory: what the shared ledger and limits files live in. */
function mockFiles(on: On, files: Files): void {
  on('fs.exists', (_, e) => ({
    value: files.has(e.path) || [...files.keys()].some(path => path.startsWith(`${e.path}/`)),
  }))
  on('fs.read', (_, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', (_, e) => ({
    value: [...files.keys()]
      .filter(path => path.startsWith(`${e.path}/`) && !path.slice(e.path.length + 1).includes('/'))
      .map(path => ({
        name: path.slice(e.path.length + 1),
        kind: 'file' as const,
        size: files.get(path)?.length ?? 0,
        mtimeMs: NOW - MINUTE,
        isLink: false,
      })),
  }))
}

type UsageSeed = {
  costUsd: number
  contextPercent?: number
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  startedAt?: number
}

function mockSession(on: On, seed: UsageSeed, sessionId = 'session-a'): void {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: {
      startedAt: seed.startedAt ?? NOW - 72 * MINUTE,
      context:
        seed.contextPercent === undefined
          ? { window: 1_000_000 }
          : { tokens: seed.contextPercent * 10_000, window: 1_000_000, percent: seed.contextPercent },
      rateLimits: seed.rateLimits,
      cost: { usd: seed.costUsd },
    },
  }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.turns', () => ({ value: 23 }))
  on('session.id', () => ({ value: sessionId }))
}

const iso = (epochMs: number) => new Date(epochMs).toISOString()

test('the desktop line: context pill, cost, then each window with its margin and time left', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME })
  mock.store(on)
  const files: Files = new Map()
  mockFiles(on, files)
  mockSession(on, {
    costUsd: 12.48,
    contextPercent: 38,
    rateLimits: [
      // 5 h window: 3 h elapsed (even pace 60 %), 42 % used: 18 points in hand.
      { kind: 'five_hour', percentUsed: 42, resetsAt: iso(NOW + 2 * HOUR) },
      // Week: half elapsed (even pace 50 %), 61 % used: 11 points ahead of pace.
      { kind: 'seven_day', percentUsed: 61, resetsAt: iso(NOW + 3.5 * DAY) },
    ],
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(JSON.stringify(await ui.drawn())).toContain('Contexte 380k/1M')
  for (const text of ['S', '$12.48', '5h', '42%', '+18%', '2h00', 'Sem.', '61%', '-11%', '3j']) {
    expect(await ui.find({ type: 'Text', text })).toBeDefined()
  }
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(3)
  // The detail row stays closed until the gear is pressed.
  expect(await ui.find({ type: 'Text', text: /Opus 5.5/ })).toBeUndefined()

  await ui.press({ key: 'details' })
  expect(await ui.find({ type: 'Text', text: /Opus 5.5 · 1h12 · 23 messages/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /5h reset 12:00, 70% au reset à ce rythme/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Sem\. reset .*, plein .* à ce rythme/ })).toBeDefined()

  // The session's spend went to its own ledger file, the windows to the shared one.
  expect(JSON.parse(files.get(`${DATA}/sessions/session-a.json`) ?? '{}')).toMatchObject({
    day: '2026-11-12',
    startUsd: 0,
    usd: 12.48,
  })
  expect(JSON.parse(files.get(`${DATA}/limits.json`) ?? '{}').windows).toHaveLength(2)
  await ui.unmount()
})

test("the open detail row adds the other sessions' spend today, and stays open across sessions", async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME })
  mock.store(on, { isExpanded: true })
  const files: Files = new Map([
    [`${DATA}/sessions/other.json`, JSON.stringify({ day: '2026-11-12', startUsd: 2, usd: 10, updatedAt: NOW - HOUR })],
    [`${DATA}/sessions/yesterday.json`, JSON.stringify({ day: '2026-11-11', startUsd: 0, usd: 50, updatedAt: NOW - DAY })],
  ])
  mockFiles(on, files)
  mockSession(on, { costUsd: 4.5, contextPercent: 12, rateLimits: [] })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  // 8 $ from the other session today plus 4.50 $ here; yesterday's is left out.
  expect(await ui.find({ type: 'Text', text: /Aujourd'hui \$12\.50 \(2 sessions\)/ })).toBeDefined()
  await ui.unmount()
})

test("a new session shows the windows another session read, and says so", async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME })
  mock.store(on, { isExpanded: true })
  const files: Files = new Map([
    [
      `${DATA}/limits.json`,
      JSON.stringify({
        windows: [{ kind: 'seven_day', percentUsed: 20, resetsAt: iso(NOW + 5 * DAY) }],
        readAt: NOW - 20 * MINUTE,
      }),
    ],
  ])
  mockFiles(on, files)
  mockSession(on, { costUsd: 0, rateLimits: [], startedAt: NOW })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: '20%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '5j' })).toBeDefined()
  expect(JSON.stringify(await ui.drawn())).toContain('Contexte —/1M')
  expect(await ui.find({ type: 'Text', text: /relevées par une autre session il y a 20min/ })).toBeDefined()
  // A session that has spent nothing writes no ledger file.
  expect(files.has(`${DATA}/sessions/session-a.json`)).toBe(false)
  await ui.unmount()
})

test('the terminal line drops the windows before the context and cost when narrow', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME })
  mock.store(on)
  mockFiles(on, new Map())
  mockSession(on, {
    costUsd: 3.2,
    contextPercent: 85,
    rateLimits: [{ kind: 'five_hour', percentUsed: 10, resetsAt: iso(NOW + 4 * HOUR) }],
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const wide = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await wide.find({ type: 'Text', text: '850k/1M' })).toBeDefined()
  expect(await wide.find({ type: 'Text', text: ' $3.20' })).toBeDefined()
  expect(await wide.find({ type: 'Text', text: ' +10%' })).toBeDefined()
  expect(await wide.find({ type: 'Text', text: ' 4h00' })).toBeDefined()
  await wide.unmount()

  const narrow = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 20 }, surface: 'terminal' })
  expect(await narrow.find({ type: 'Text', text: ' $3.20' })).toBeDefined()
  expect(await narrow.find({ type: 'Text', text: '5h ' })).toBeUndefined()
  await narrow.unmount()
})

test('the band yields to a survey', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME })
  mock.store(on)
  mockFiles(on, new Map())
  mockSession(on, { costUsd: 1, rateLimits: [] })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>survey</Text>
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true }, surface: 'desktop' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('survey')
  await ui.unmount()
})
