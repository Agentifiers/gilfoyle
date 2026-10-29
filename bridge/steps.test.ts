import { afterEach, beforeEach, expect, test, vi } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

process.env.GILFOYLE_DATA = mkdtempSync(join(tmpdir(), 'gilfoyle-'))
// Imported after GILFOYLE_DATA is set: config.ts reads it when it loads.
const steps = await import('./steps.ts')
const { WORLDS_DIR } = await import('./config.ts')

const INTERVAL = 3000
type Sent = { method: 'post' | 'update'; title: string; tasks: { task_id: string; title: string; status: string }[] }
let sent: Sent[] = []
let failPost = false

beforeEach(() => {
  vi.useFakeTimers()
  sent = []
  failPost = false
  steps.init({
    post: async (_target, m) => {
      if (failPost) throw new Error('not_in_channel')
      sent.push({ method: 'post', title: m.blocks[0].title, tasks: structuredClone(m.blocks[0].tasks) })
      return '111.222'
    },
    update: async (_channel, _ts, m) => { sent.push({ method: 'update', title: m.blocks[0].title, tasks: structuredClone(m.blocks[0].tasks) }) },
    debug: () => {},
    intervalMs: INTERVAL,
  })
})
afterEach(() => vi.useRealTimers())

/** Advance the clock, then let the Slack calls it started settle. */
async function advance(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms)
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

const bash = (id: string, description: string) => ({ id, name: 'Bash', input: { command: `echo ${id}`, description } })
const lookup = (id: string) => ({ id, name: 'mcp__slack__read_replies', input: {} })
const statuses = (s: Sent) => s.tasks.map(t => `${t.title}:${t.status}`)

test('a turn that only reads Slack and replies posts nothing', async () => {
  const turn = steps.begin({ channel: 'C1', thread_ts: '1.1' })
  turn.start(lookup('a'))
  turn.finish('a', false)
  turn.start({ id: 'b', name: 'mcp__slack__reply', input: { text: 'hi' } })
  turn.finish('b', false)
  await turn.end(true)
  expect(sent).toEqual([])
})

test('real work posts the plan, earlier lookups included, and the end gives it a final title', async () => {
  const turn = steps.begin({ channel: 'C1', thread_ts: '1.1' })
  turn.start(lookup('a'))
  turn.finish('a', false)
  turn.start(bash('b', 'List merged PRs'))
  await advance(0)
  expect(sent).toHaveLength(1)
  expect(sent[0].method).toBe('post')
  expect(sent[0].title).toBe('Working…')
  expect(statuses(sent[0])).toEqual(['Reading the thread:complete', 'List merged PRs:in_progress'])
  await advance(65_000)
  turn.finish('b', false)
  await turn.end(true)
  const last = sent.at(-1)!
  expect(last.method).toBe('update')
  expect(last.title).toBe('Worked for 1m 5s')
  expect(statuses(last)).toEqual(['Reading the thread:complete', 'List merged PRs:complete'])
})

test('updates wait out the interval and carry every change made meanwhile', async () => {
  const turn = steps.begin({ channel: 'C1' })
  turn.start(bash('a', 'one'))
  await advance(0)
  turn.finish('a', false)
  turn.start(bash('b', 'two'))
  turn.finish('b', true)
  turn.start(bash('c', 'three'))
  await advance(INTERVAL - 1)
  expect(sent.map(s => s.method)).toEqual(['post'])
  await advance(1)
  expect(sent.map(s => s.method)).toEqual(['post', 'update'])
  expect(statuses(sent[1])).toEqual(['one:complete', 'two:error', 'three:in_progress'])
  await turn.end(true)
})

test('a stopped turn marks unfinished steps as errors', async () => {
  const turn = steps.begin({ channel: 'C1' })
  turn.start(bash('a', 'long build'))
  await advance(12_000)
  await turn.end(false)
  const last = sent.at(-1)!
  expect(last.title).toBe('Stopped after 12s')
  expect(statuses(last)).toEqual(['long build:error'])
})

test('past 50 steps the oldest fold into one line', async () => {
  const turn = steps.begin({ channel: 'C1' })
  for (let i = 0; i < 60; i++) { turn.start(bash(`t${i}`, `step ${i}`)); turn.finish(`t${i}`, false) }
  await turn.end(true)
  const tasks = sent.at(-1)!.tasks
  expect(tasks).toHaveLength(50)
  expect(tasks[0]).toEqual({ task_id: 'earlier', title: '11 earlier steps', status: 'complete' })
  expect(tasks[1].title).toBe('step 11')
  expect(tasks[49].title).toBe('step 59')
})

test('tokens never reach Slack', async () => {
  const token = 'ghp_' + 'a'.repeat(36)
  const turn = steps.begin({ channel: 'C1' })
  turn.start({ id: 'a', name: 'Bash', input: { command: `curl -H "Authorization: token ${token}" https://api.github.com` } })
  await turn.end(true)
  const text = JSON.stringify(sent)
  expect(text).not.toContain(token)
  expect(text).toContain('[REDACTED]')
})

test('if Slack refuses the plan, the turn stops trying', async () => {
  failPost = true
  const turn = steps.begin({ channel: 'C1' })
  turn.start(bash('a', 'one'))
  await advance(0)
  failPost = false
  turn.finish('a', false)
  await advance(INTERVAL)
  await turn.end(true)
  expect(sent).toEqual([])
})

test('describe: Slack actions are not steps; files show from the repo down', () => {
  expect(steps.describe('mcp__slack__reply', {})).toBeUndefined()
  expect(steps.describe('mcp__slack__react', {})).toBeUndefined()
  expect(steps.describe('TodoWrite', {})).toBeUndefined()
  expect(steps.describe('Read', { file_path: join(WORLDS_DIR, '2', 'api', 'src', 'billing.ts') })?.title).toBe('Reading api/src/billing.ts')
  expect(steps.describe('Bash', { command: 'git log --oneline -5\ngit status' })).toEqual({ kind: 'work', title: 'git log --oneline -5', details: 'git log --oneline -5\ngit status' })
  expect(steps.describe('mcp__jira__getIssue', { key: 'ENG-1' })).toEqual({ kind: 'work', title: 'jira: getIssue' })
  expect(steps.describe('WebFetch', { url: 'https://docs.slack.dev/x', prompt: 'p' })?.sources).toEqual([{ type: 'url', url: 'https://docs.slack.dev/x', text: 'docs.slack.dev' }])
})

test('describe: browser steps name the page and element, never what was typed', () => {
  expect(steps.describe('mcp__browser__browser_navigate', { url: 'https://status.example.com/incidents' }))
    .toEqual({ kind: 'work', title: 'Opening status.example.com', sources: [{ type: 'url', url: 'https://status.example.com/incidents', text: 'status.example.com' }] })
  const typed = steps.describe('mcp__browser__browser_type', { element: 'Search box', target: 'e12', text: 'hunter2' })
  expect(typed).toEqual({ kind: 'work', title: 'Typing into Search box' })
  expect(JSON.stringify(steps.describe('mcp__browser__browser_fill_form', { fields: [{ name: 'Password', value: 'hunter2' }] }))).not.toContain('hunter2')
})

test('tool calls and results come out of SDK message content, other blocks ignored', () => {
  expect(steps.toolCalls([{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'ls' } }]))
    .toEqual([{ id: 'u1', name: 'Bash', input: { command: 'ls' } }])
  expect(steps.toolResults([{ type: 'tool_result', tool_use_id: 'u1', is_error: true, content: 'boom' }, { type: 'text', text: 'x' }]))
    .toEqual([{ id: 'u1', failed: true }])
  expect(steps.toolResults('plain prompt')).toEqual([])
})
