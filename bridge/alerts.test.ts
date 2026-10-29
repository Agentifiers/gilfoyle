import { afterAll, beforeEach, expect, mock, setSystemTime, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

process.env.GILFOYLE_DATA = mkdtempSync(join(tmpdir(), 'gilfoyle-'))
const { parseAlert, handleAlert, init, notifyMention } = await import('./alerts.ts')
const { STATE_DIR, writeJson } = await import('./config.ts')

test.each([
  ['cloudwatch', 'CloudWatch Alarm: api-5xx - OK -> ALARM', { name: 'api-5xx', firing: true }],
  ['cloudwatch', 'CloudWatch Alarm: api-5xx - ALARM → OK', { name: 'api-5xx', firing: false }],
  ['cloudwatch', 'CloudWatch Alarm: api-5xx - OK -> INSUFFICIENT_DATA', null],
  ['datadog', '[Triggered] High error rate on checkout', { name: 'High error rate on checkout', firing: true }],
  ['datadog', 'Re-Triggered: High error rate on checkout', { name: 'High error rate on checkout', firing: true }],
  ['datadog', '[Triggered on {host:web-1}] Disk full', { name: 'Disk full', firing: true }],
  ['datadog', 'Recovered: High error rate on checkout', { name: 'High error rate on checkout', firing: false }],
  ['datadog', '[Warn] Latency creeping', null],
  ['incidentio', 'Firing: Checkout latency p99 > 2s', { name: 'Checkout latency p99 > 2s', firing: true }],
  ['incidentio', 'Resolved | Checkout latency p99 > 2s', { name: 'Checkout latency p99 > 2s', firing: false }],
  ['datadog', 'deploy finished for checkout', null],
])('%s parses %p', (source, text, expected) => {
  expect(parseAlert(text, source)).toEqual(expected as any)
})

test('custom source without a name group', () => {
  const src = { pattern: String.raw`^(?<state>PROBLEM|RECOVERY)\b`, firing: 'PROBLEM', resolved: 'RECOVERY' }
  expect(parseAlert('PROBLEM: db down', src)).toEqual({ name: '', firing: true })
})

const deps = { react: mock(), watch: mock(), wake: mock(), debug: () => {} }
const cfg = { source: 'cloudwatch', env: 'prod', posters: ['BCW'], ignore: ['*-canary'] }
const fire = (ts: string, name = 'api-5xx') => handleAlert({ channel: 'C1', ts }, `CloudWatch Alarm: ${name} - OK -> ALARM`, cfg)
const ok = (ts: string, name = 'api-5xx') => handleAlert({ channel: 'C1', ts }, `CloudWatch Alarm: ${name} - ALARM -> OK`, cfg)
const t0 = new Date('2026-10-28T10:00:00Z').getTime()

afterAll(() => setSystemTime())

beforeEach(() => {
  writeJson(join(STATE_DIR, 'alerts.json'), {})
  setSystemTime(t0)
  init(deps)
  for (const m of [deps.react, deps.watch, deps.wake]) m.mockClear()
})

test('resolve during holdoff never wakes', async () => {
  fire('1.0')
  ok('2.0')
  setSystemTime(t0 + 6 * 60_000)
  await Bun.sleep(5)
  expect(deps.wake).not.toHaveBeenCalled()
})

test('ignored alerts are swallowed without an incident', () => {
  expect(fire('1.0', 'wgs-canary')).toBe(true)
  expect(deps.react).not.toHaveBeenCalled()
})

test('a holdoff from before a restart still wakes', async () => {
  fire('1.0')
  // Simulate restart 4 minutes later: timers are gone, state is on disk.
  setSystemTime(t0 + 4 * 60_000)
  init(deps)
  setSystemTime(t0 + 10 * 60_000)
  init(deps)
  await Bun.sleep(5)
  expect(deps.wake).toHaveBeenCalledTimes(1)
  expect(deps.wake.mock.calls[0][1]).toMatchObject({ chat_id: 'C1', thread_ts: '1.0', alert: 'api-5xx', env: 'prod' })
})

test('an investigated alert resolving tells the bot, and the next fire is fresh', async () => {
  fire('1.0')
  setSystemTime(t0 + 6 * 60_000)
  init(deps) // re-arms with 0 delay
  await Bun.sleep(5)
  expect(deps.wake).toHaveBeenCalledTimes(1)
  fire('3.0') // repeat while open: absorbed
  expect(deps.wake).toHaveBeenCalledTimes(1)
  ok('4.0')
  expect(deps.wake).toHaveBeenCalledTimes(2)
  expect(deps.wake.mock.calls[1][0]).toStartWith('[ALERT RESOLVED]')
  expect(fire('5.0')).toBe(true)
  expect(deps.react).toHaveBeenLastCalledWith('C1', '5.0', 'hourglass_flowing_sand')
})

test('a human mention skips the holdoff wake', async () => {
  fire('1.0')
  notifyMention('C1', '1.0')
  setSystemTime(t0 + 6 * 60_000)
  init(deps)
  await Bun.sleep(5)
  expect(deps.wake).not.toHaveBeenCalled()
})

test('the third flap within an hour wakes the bot', () => {
  for (let i = 0; i < 2; i++) { fire(`${i}.0`); ok(`${i}.5`) }
  expect(deps.wake).not.toHaveBeenCalled()
  fire('9.0')
  expect(deps.wake).toHaveBeenCalledTimes(1)
  expect(deps.wake.mock.calls[0][0]).toContain('is flapping')
  expect(deps.react).toHaveBeenLastCalledWith('C1', '9.0', 'eyes')
})
