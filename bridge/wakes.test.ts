import { expect, mock, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

process.env.GILFOYLE_DATA = mkdtempSync(join(tmpdir(), 'gilfoyle-'))
const wakes = await import('./wakes.ts')

test('escalation clock: only a tagged person replying after the tag cancels it', async () => {
  const fired = mock()
  wakes.init(fired)
  wakes.schedule({ channel: 'C1', thread: '1.0', name: 'escalation', fire_at: Date.now() + 50, reason: 'escalate', until_reply_from: ['U1'], after_ts: '5.0' })
  wakes.notifyReply('C1', '1.0', 'U2', '6.0') // someone else
  wakes.notifyReply('C1', '1.0', 'U1', '4.0') // tagged person, but before the tag
  await Bun.sleep(80)
  expect(fired).toHaveBeenCalledTimes(1)

  wakes.schedule({ channel: 'C1', thread: '1.0', name: 'escalation', fire_at: Date.now() + 50, reason: 'escalate', until_reply_from: ['U1'], after_ts: '5.0' })
  wakes.notifyReply('C1', '1.0', 'U1', '6.0')
  await Bun.sleep(80)
  expect(fired).toHaveBeenCalledTimes(1)
})

test('wakes survive a restart', async () => {
  wakes.init(() => {})
  wakes.schedule({ channel: 'C2', thread: '2.0', name: 'recheck', fire_at: Date.now() + 50, reason: 'recheck' })
  const fired = mock()
  wakes.init(fired) // reload from disk, as on restart
  await Bun.sleep(80)
  expect(fired).toHaveBeenCalledTimes(1)
  expect(fired.mock.calls[0][0]).toMatchObject({ channel: 'C2', reason: 'recheck' })
})

test('named wakes on one thread are independent', async () => {
  const fired = mock()
  wakes.init(fired)
  wakes.schedule({ channel: 'C3', thread: '3.0', name: 'escalation', fire_at: Date.now() + 50, reason: 'escalate', until_reply_from: ['U1'] })
  wakes.schedule({ channel: 'C3', thread: '3.0', name: 'review', fire_at: Date.now() + 50, reason: 'check review' })
  wakes.notifyReply('C3', '3.0', 'U1', '9.0')
  await Bun.sleep(80)
  expect(fired.mock.calls.map(c => c[0].name)).toEqual(['review'])
})
