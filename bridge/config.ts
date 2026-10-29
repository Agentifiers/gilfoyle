/** The one config file: `gilfoyle.yaml` at the repo root, read once at startup. Change it and redeploy. */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'

export interface AlertSource {
  /** Regex with a `state` group and an optional `name` group. Without `name`, the alert is keyed by message ts. */
  pattern: string
  firing: string
  resolved: string
}

export interface AlertChannel {
  env?: string
  source: string | AlertSource
  /** Bot IDs that post the alerts. They need not be in `bots`. Humans never count. */
  posters: string[]
  /** Alert-name globs to ignore, e.g. "*-canary". */
  ignore?: string[]
}

export interface Member {
  email: string
  name?: string
  /** May direct write actions. */
  engineer?: boolean
  /** On the alert escalation list, in file order. */
  escalation?: boolean
}

export interface Cron {
  name: string
  /** Five-field cron expression, in `timezone`. */
  schedule: string
  /** Channel the bot works in when the job fires. */
  channel: string
  prompt: string
}

export type Model =
  | { provider: 'bedrock'; name: string; region: string }
  /** `base_url` points at a gateway that speaks the Anthropic Messages API, e.g. for testing. */
  | { provider: 'anthropic'; name: string; base_url?: string }

export interface Config {
  name: string
  model: Model
  /** Email of the person who hears about refusals. */
  owner: string
  timezone: string
  holidays: string[]
  github: { org: string; repos: { name: string; setup?: string }[] }
  worlds: number
  /** Headless Chromium for the agent, through Playwright MCP behind the egress guard (bridge/browser.ts). */
  browser: boolean
  members: Member[]
  /** Bot IDs whose messages reach the bot at all, with a label. Everything else from bots is dropped. */
  bots: Record<string, string>
  alerts: Record<string, AlertChannel>
  /** Channels where a listed bot's top-level posts wake the bot, e.g. a support-ticket feed. */
  tickets: Record<string, { posters: string[] }>
  /** MCP servers for the agent, e.g. the ticket tracker. `${VAR}` is replaced from the environment. */
  tools: Record<string, unknown>
  crons: Cron[]
  /** Free-form instructions appended to CLAUDE.md. */
  notes: string
}

const ROOT = join(import.meta.dir, '..')
export const CONFIG_FILE = process.env.GILFOYLE_CONFIG ?? join(ROOT, 'gilfoyle.yaml')
export const DATA_DIR = process.env.GILFOYLE_DATA ?? '/data'
export const STATE_DIR = join(DATA_DIR, 'state')
export const WORLDS_DIR = join(DATA_DIR, 'worlds')
export const SESSION_DIR = join(DATA_DIR, 'session')

export function loadConfig(file = CONFIG_FILE): Config {
  const c = Bun.YAML.parse(readFileSync(file, 'utf8')) as Config
  const fail = (msg: string) => { throw new Error(`${file}: ${msg}`) }
  for (const key of ['name', 'owner', 'timezone', 'model', 'github', 'members'] as const) {
    if (c[key] === undefined) fail(`"${key}" is required`)
  }
  if (!c.github.org || !c.github.repos?.length) fail('github.org and github.repos are required')
  if (!c.model.name) fail('model.name is required')
  if (c.model.provider === 'bedrock' ? !c.model.region : c.model.provider !== 'anthropic') {
    fail('model.provider must be bedrock (with region) or anthropic')
  }
  c.worlds ??= 3
  c.browser ??= true
  c.holidays = (c.holidays ?? []).map(String)
  c.members = c.members.map(m => ({ ...m, email: m.email.toLowerCase() }))
  c.owner = c.owner.toLowerCase()
  c.bots ??= {}
  c.alerts ??= {}
  c.tickets ??= {}
  c.tools ??= {}
  c.crons ??= []
  c.notes ??= ''
  for (const [channel, a] of Object.entries(c.alerts)) {
    if (!a.posters?.length || a.posters.some(p => !/^B[A-Z0-9]+$/.test(p))) {
      fail(`alerts.${channel}.posters must list the alerting bot's ID (B...)`)
    }
  }
  for (const job of c.crons) {
    if (!job.name || !job.channel || !job.prompt) fail('each cron needs name, schedule, channel and prompt')
    try { Bun.cron.parse(job.schedule, new Date(), { tz: c.timezone }) } catch (err) { fail(`crons.${job.name}: ${err}`) }
  }
  return c
}

/** Environment for the Claude Code process that selects the model provider. Credentials come from the container env. */
export function providerEnv(m: Model, env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env }
  for (const k of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL']) delete out[k]
  if (m.provider === 'bedrock') Object.assign(out, { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: m.region })
  else if (m.base_url) out.ANTHROPIC_BASE_URL = m.base_url
  return out
}

/** The Team section of CLAUDE.md, written from the config so the model and the bridge read the same facts. */
export function teamSection(c: Config): string {
  const who = (m: Member) => m.name ? `${m.name} (${m.email})` : m.email
  const lines = [
    '# Team',
    '',
    `You work for **${c.name}**. Your owner is ${c.owner}; DM them about refusals.`,
    `Repos, in the \`${c.github.org}\` GitHub org: ${c.github.repos.map(r => `\`${r.name}\``).join(', ')}.`,
    `Engineers: ${c.members.filter(m => m.engineer).map(who).join(', ') || 'none'}.`,
    `Escalation list, in order: ${c.members.filter(m => m.escalation).map(who).join(', ') || 'none'}.`,
    `Default timezone: \`${c.timezone}\`. Holidays: ${c.holidays.join(', ') || 'none'}.`,
  ]
  const alertChannels = Object.entries(c.alerts)
  if (alertChannels.length) lines.push(`Alert channels: ${alertChannels.map(([id, a]) => `<#${id}>${a.env ? ` (${a.env})` : ''}`).join(', ')}.`)
  if (c.notes.trim()) lines.push('', c.notes.trim())
  return lines.join('\n') + '\n'
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value))
  renameSync(tmp, file)
}
