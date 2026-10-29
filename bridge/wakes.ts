/**
 * Scheduled wakes: "wake me at <time> about this thread". Used for escalation
 * clocks (cancelled when a tagged person replies), business-hours deferrals,
 * and PR review re-checks. A thread can hold several wakes, one per name;
 * scheduling the same name again replaces it.
 */

import { join } from 'path'
import { STATE_DIR, readJson, writeJson } from './config.ts'

export interface Wake {
  channel: string
  thread: string
  name: string
  fire_at: number
  reason: string
  /** Cancel automatically when one of these Slack user IDs posts in the thread. */
  until_reply_from?: string[]
  /** Only replies newer than this ts count. */
  after_ts?: string
}

const FILE = join(STATE_DIR, 'wakes.json')
let wakes: Record<string, Wake> = {}
const timers = new Map<string, ReturnType<typeof setTimeout>>()
let fire: (w: Wake) => void

const keyOf = (w: Pick<Wake, 'channel' | 'thread' | 'name'>) => `${w.channel}:${w.thread}:${w.name}`

function arm(key: string, w: Wake): void {
  clearTimeout(timers.get(key))
  // setTimeout overflows past ~24.8 days; re-arm in steps.
  const delay = Math.min(Math.max(0, w.fire_at - Date.now()), 2 ** 31 - 1)
  timers.set(key, setTimeout(() => {
    if (Date.now() < w.fire_at) return arm(key, w)
    timers.delete(key)
    delete wakes[key]
    writeJson(FILE, wakes)
    fire(w)
  }, delay))
}

export function init(onFire: (w: Wake) => void): void {
  fire = onFire
  wakes = readJson(FILE, {})
  for (const [key, w] of Object.entries(wakes)) arm(key, w)
}

export function schedule(w: Wake): void {
  const key = keyOf(w)
  wakes[key] = w
  writeJson(FILE, wakes)
  arm(key, w)
}

/** Cancels the named wake on a thread, or every wake on it when name is omitted. */
export function cancel(channel: string, thread: string, name?: string): number {
  const matches = Object.entries(wakes).filter(([, w]) => w.channel === channel && w.thread === thread && (!name || w.name === name))
  for (const [key] of matches) {
    clearTimeout(timers.get(key))
    timers.delete(key)
    delete wakes[key]
  }
  if (matches.length) writeJson(FILE, wakes)
  return matches.length
}

export function notifyReply(channel: string, thread: string, user: string, ts: string): void {
  for (const w of Object.values(wakes)) {
    if (w.channel !== channel || w.thread !== thread || !w.until_reply_from?.includes(user)) continue
    if (w.after_ts && Number(ts) <= Number(w.after_ts)) continue
    cancel(channel, thread, w.name)
  }
}
