/**
 * Alert triage. A bot-posted alert in a configured channel opens an incident.
 * If it is still firing after the holdoff, the bot is woken to investigate.
 * A resolve during holdoff closes it silently; repeat fires while it is open are
 * absorbed. An alert that keeps resolving inside the holdoff wakes the bot on
 * its third flap within an hour. Reactions show the state: ⏳ holdoff,
 * 👀 investigating, ✅ resolved.
 */

import { join } from 'path'
import { STATE_DIR, readJson, writeJson, type AlertChannel, type AlertSource } from './config.ts'

export const SOURCES: Record<string, AlertSource> = {
  // "CloudWatch Alarm: <name> - OK -> ALARM"
  cloudwatch: {
    pattern: String.raw`CloudWatch Alarm:\s+(?<name>\S+)\s+-\s+\w+\s*(?:→|->)\s*(?<state>\w+)`,
    firing: '^ALARM$',
    resolved: '^OK$',
  },
  // "[Triggered] <monitor>", "Recovered: <monitor>", "[Triggered on {host:a}] <monitor>"
  datadog: {
    pattern: String.raw`\[?(?<state>Re-Triggered|Triggered|Recovered|Warn|No Data)(?: on [^\]\n]*)?\]?:?\s+(?<name>[^\n]+)`,
    firing: 'Triggered',
    resolved: '^Recovered$',
  },
  // "Firing: <alert title>" / "Resolved: <alert title>"
  incidentio: {
    pattern: String.raw`(?<state>Firing|Resolved)\b[\s:|-]*(?<name>[^\n]+)`,
    firing: '^Firing$',
    resolved: '^Resolved$',
  },
}

const HOLDOFF_MS = 5 * 60_000
const FLAP_WINDOW_MS = 3600_000
const FLAPS_TO_WAKE = 3
/** A fire on an incident open longer than this starts a fresh investigation. */
const OPEN_TTL_MS = 24 * 3600_000

export interface Alert { name: string; firing: boolean }

export function parseAlert(text: string, source: string | AlertSource): Alert | null {
  const s = typeof source === 'string' ? SOURCES[source] : source
  const m = new RegExp(s.pattern, 'i').exec(text)
  const state = m?.groups?.state
  if (!state) return null
  const firing = new RegExp(s.firing, 'i').test(state)
  const resolved = new RegExp(s.resolved, 'i').test(state)
  if (firing === resolved) return null
  return { name: (m.groups?.name ?? '').trim(), firing }
}

function glob(pattern: string): RegExp {
  return new RegExp('^' + pattern.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
}

interface Incident {
  channel: string
  name: string
  thread: string
  env?: string
  text: string
  /** The message that opened this incident, where the state reaction goes. */
  ts: string
  state: 'holdoff' | 'open'
  since: number
}

export interface AlertDeps {
  react(channel: string, ts: string, emoji: string): void
  watch(channel: string, thread: string): void
  wake(content: string, meta: Record<string, string>): void
  debug(msg: string): void
}

const FILE = join(STATE_DIR, 'alerts.json')
let deps: AlertDeps
let incidents: Record<string, Incident> = {}
/** Recent resolve-during-holdoff times per alert, in memory only. */
const flaps = new Map<string, number[]>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

function persist(): void {
  writeJson(FILE, incidents)
}

function open(key: string, why: string): void {
  clearTimeout(timers.get(key))
  timers.delete(key)
  const inc = incidents[key]
  inc.state = 'open'
  persist()
  deps.react(inc.channel, inc.ts, 'eyes')
  deps.watch(inc.channel, inc.thread)
  deps.wake(
    `[ALERT] \`${inc.name}\`${inc.env ? ` (${inc.env})` : ''} ${why}. Investigate per CLAUDE.md "Alerts" and reply in this thread.\n\n${inc.text}`,
    { chat_id: inc.channel, thread_ts: inc.thread, alert: inc.name, ...(inc.env ? { env: inc.env } : {}), first_seen_at: new Date(inc.since).toISOString() },
  )
}

function armHoldoff(key: string, ms: number): void {
  clearTimeout(timers.get(key))
  timers.set(key, setTimeout(() => {
    if (incidents[key]?.state === 'holdoff') open(key, `has been firing for ${HOLDOFF_MS / 60_000} minutes`)
  }, Math.max(0, ms)))
}

export function init(d: AlertDeps): void {
  deps = d
  incidents = readJson(FILE, {})
  flaps.clear()
  const now = Date.now()
  for (const [key, inc] of Object.entries(incidents)) {
    if (now - inc.since > OPEN_TTL_MS) delete incidents[key]
    else if (inc.state === 'holdoff') armHoldoff(key, inc.since + HOLDOFF_MS - now)
  }
  persist()
}

/** Returns true when the message was an alert and is fully handled here. The caller checks the poster. */
export function handleAlert(
  ev: { channel: string; ts: string; thread_ts?: string },
  text: string,
  cfg: AlertChannel,
): boolean {
  const alert = parseAlert(text, cfg.source)
  if (!alert) return false

  if (cfg.ignore?.some(g => glob(g).test(alert.name))) {
    deps.debug(`alerts: ignoring ${alert.name}`)
    return true
  }
  const thread = ev.thread_ts ?? ev.ts
  const key = `${ev.channel}:${alert.name || thread}`
  const existing = incidents[key]

  if (!alert.firing) {
    if (!existing) return true
    clearTimeout(timers.get(key))
    timers.delete(key)
    delete incidents[key]
    persist()
    deps.react(ev.channel, ev.ts, 'white_check_mark')
    if (existing.state === 'holdoff') {
      const recent = (flaps.get(key) ?? []).filter(t => Date.now() - t < FLAP_WINDOW_MS)
      flaps.set(key, [...recent, Date.now()])
    }
    if (existing.state === 'open') {
      deps.wake(
        `[ALERT RESOLVED] \`${existing.name}\` recovered. Post the disposition if you haven't, and cancel this thread's \`escalation\` wake.`,
        { chat_id: existing.channel, thread_ts: existing.thread, alert: existing.name },
      )
    }
    return true
  }

  if (existing && Date.now() - existing.since < OPEN_TTL_MS) {
    deps.debug(`alerts: ${key} fired again while ${existing.state}`)
    return true
  }
  incidents[key] = { channel: ev.channel, name: alert.name || '(unnamed alert)', thread, ts: ev.ts, env: cfg.env, text: text.slice(0, 3000), state: 'holdoff', since: Date.now() }
  persist()
  deps.react(ev.channel, ev.ts, 'hourglass_flowing_sand')
  const flapCount = (flaps.get(key) ?? []).filter(t => Date.now() - t < FLAP_WINDOW_MS).length
  if (flapCount + 1 >= FLAPS_TO_WAKE) {
    flaps.delete(key)
    open(key, `is flapping: it fired ${flapCount + 1} times in the last hour, resolving each time`)
  } else {
    armHoldoff(key, HOLDOFF_MS)
  }
  return true
}

/** A human @mention in an alert thread starts the investigation now, through the mention itself. */
export function notifyMention(channel: string, thread: string): void {
  for (const [key, inc] of Object.entries(incidents)) {
    if (inc.channel !== channel || inc.thread !== thread || inc.state !== 'holdoff') continue
    clearTimeout(timers.get(key))
    timers.delete(key)
    inc.state = 'open'
    persist()
    deps.react(channel, inc.ts, 'eyes')
  }
}
