/**
 * Slack code channels: one channel per task, each with its own agent session,
 * a session status, a context bar and a diff tab. The bridge keeps the status in
 * step with the channel's session: "processing" during a turn, "active" when it
 * ends, "suspended" when the agent says it is waiting on an answer, and "closed"
 * once the channel is archived.
 */

import { execFileSync } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync, readdirSync, realpathSync } from 'fs'
import { join } from 'path'
import { STATE_DIR, WORLDS_DIR, readJson, writeJson } from './config.ts'

const FILE = join(STATE_DIR, 'code-channels.json')
const TTL_MS = 30 * 24 * 3600_000
const API = process.env.SLACK_API_URL ?? 'https://slack.com/api/'

/** Code channel ID → its agent session ID and when the bridge first saw it. */
let channels: Record<string, { session: string; at: number }> = {}
const waiting = new Set<string>()
let debug: (msg: string) => void = () => {}

/** The agents.* methods aren't in the Slack SDK yet; they take JSON bodies. */
export async function call(method: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(API + method, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  })
  const json: any = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))
  if (!json.ok) throw new Error(`${method}: ${json.error}`)
  return json
}

function setStatus(channel: string, status: 'processing' | 'active' | 'suspended' | 'closed'): void {
  call('agents.sessions.setStatus', { channel_id: channel, status }).catch(err => debug(String(err)))
}

/** Load remembered channels and mark them idle, since nothing is running after a restart. */
export function init(log: (msg: string) => void): void {
  debug = log
  channels = Object.fromEntries(Object.entries(readJson<typeof channels>(FILE, {})).filter(([, c]) => Date.now() - c.at < TTL_MS))
  writeJson(FILE, channels)
  for (const channel of Object.keys(channels)) setStatus(channel, 'active')
}

export const isCode = (channel: string) => channel in channels
export const sessionId = (channel: string) => channels[channel]?.session

export function remember(channel: string): void {
  channels[channel] ??= { session: randomUUID(), at: Date.now() }
  writeJson(FILE, channels)
}

export function forget(channel: string): void {
  delete channels[channel]
  waiting.delete(channel)
  writeJson(FILE, channels)
}

/** The channel was archived: close its session for good and stop tracking it. */
export function close(channel: string): void {
  setStatus(channel, 'closed')
  forget(channel)
}

/** The channel's session started a turn. */
export function startTurn(channel: string): void {
  waiting.delete(channel)
  setStatus(channel, 'processing')
}

/** The agent posted a question and can't continue without an answer. */
export function waitForReply(channel: string): void {
  waiting.add(channel)
  setStatus(channel, 'suspended')
}

/** The channel's session ended a turn. It goes idle, unless it's waiting on an answer or was closed during the turn. */
export function endTurn(channel: string): void {
  if (isCode(channel) && !waiting.has(channel)) setStatus(channel, 'active')
}

/** Someone pressed stop. Slack sets the status itself. */
export function stop(channel: string): void {
  waiting.delete(channel)
}

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

/** Every repo's changes in a world against where its branch left main, with paths prefixed by repo. */
export function worldDiff(world: string): { diff: string; branch: string } {
  const real = realpathSync(world)
  if (!real.startsWith(realpathSync(WORLDS_DIR) + '/')) throw new Error(`world must be under ${WORLDS_DIR}`)
  let diff = ''
  let branch = ''
  for (const repo of readdirSync(real).sort()) {
    const dir = join(real, repo)
    if (!existsSync(join(dir, '.git'))) continue
    const base = git(dir, 'merge-base', 'origin/main', 'HEAD').trim()
    const d = git(dir, 'diff', '--no-color', `--src-prefix=a/${repo}/`, `--dst-prefix=b/${repo}/`, base)
    if (!d) continue
    diff += d
    branch ||= git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
  }
  return { diff, branch }
}
