#!/usr/bin/env bun
/**
 * Gilfoyle: Claude agent sessions (Agent SDK) fed by Slack. One main session
 * handles DMs, threads, alerts and crons; each code channel gets its own session
 * so tasks run in parallel. Every Slack message goes through `onMessage` and
 * becomes a user turn in its session; the agent answers through the Slack tools
 * defined here. Config comes from gilfoyle.yaml.
 */

import { createSdkMcpServer, query, tool, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'crypto'
import App from '@slack/bolt'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import { DATA_DIR, SESSION_DIR, STATE_DIR, WORLDS_DIR, loadConfig, providerEnv, readJson, teamSection, writeJson } from './config.ts'
import * as alerts from './alerts.ts'
import * as wakes from './wakes.ts'
import * as code from './code.ts'
import * as steps from './steps.ts'
import * as browser from './browser.ts'

const config = loadConfig()
const engineers = new Set(config.members.filter(m => m.engineer).map(m => m.email))
const BOT_TOKEN = process.env.SLACK_BOT_TOKEN
const APP_TOKEN = process.env.SLACK_APP_TOKEN
if (!BOT_TOKEN || !APP_TOKEN) throw new Error('SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required')

const LOG_FILE = join(DATA_DIR, 'bridge.log')
const DOWNLOAD_DIR = join(DATA_DIR, 'downloads')
for (const dir of [DOWNLOAD_DIR, STATE_DIR, WORLDS_DIR, SESSION_DIR]) mkdirSync(dir, { recursive: true })
// The session reads CLAUDE.md from its working dir: shared instructions plus the team section from the config.
writeFileSync(join(SESSION_DIR, 'CLAUDE.md'), readFileSync(join(import.meta.dir, '..', 'CLAUDE.md'), 'utf8') + '\n' + teamSection(config))

function log(event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ t: new Date().toISOString(), event, ...fields }) + '\n'
  process.stderr.write(line)
  try { appendFileSync(LOG_FILE, line) } catch {}
}
process.on('unhandledRejection', err => log('unhandled_rejection', { err: String(err) }))
process.on('uncaughtException', err => {
  log('uncaught_exception', { err: String(err) })
  process.exit(1)
})

const quiet = (level: string) => (...a: unknown[]) => log(`bolt_${level}`, { msg: a.join(' ') })
const slackApiUrl = process.env.SLACK_API_URL // for tests against a fake Slack
const slack = new App({
  token: BOT_TOKEN,
  appToken: APP_TOKEN,
  socketMode: true,
  ...(slackApiUrl ? { clientOptions: { slackApiUrl }, installerOptions: { clientOptions: { slackApiUrl } } } : {}),
  logger: { debug: () => {}, info: quiet('info'), warn: quiet('warn'), error: quiet('error'), getLevel: () => 'info', setLevel: () => {}, setName: () => {} } as any,
})
const web = slack.client
let botUserId = ''
let botBotId = ''

// ── Watched threads: replies in these reach the bot without an @mention ─────

const WATCHED_FILE = join(STATE_DIR, 'watched.json')
const WATCH_TTL_MS = 30 * 24 * 3600_000
const watched = new Map<string, number>(Object.entries(readJson<Record<string, number>>(WATCHED_FILE, {}))
  .filter(([, at]) => Date.now() - at < WATCH_TTL_MS))

function watch(channel: string, thread: string): void {
  watched.set(`${channel}:${thread}`, Date.now())
  writeJson(WATCHED_FILE, Object.fromEntries(watched))
}

// Slack may deliver an event more than once.
const seen = new Set<string>()
function claim(key: string): boolean {
  if (seen.has(key)) return false
  seen.add(key)
  if (seen.size > 2000) seen.delete(seen.values().next().value!)
  return true
}

// ── Slack helpers ───────────────────────────────────────────────────────────

const users = new Map<string, { name: string; email: string }>()
async function resolveUser(id: string): Promise<{ name: string; email: string }> {
  const hit = users.get(id)
  if (hit) return hit
  try {
    const { user } = await web.users.info({ user: id })
    const r = { name: user?.profile?.real_name || user?.name || id, email: (user?.profile?.email ?? '').toLowerCase() }
    users.set(id, r)
    return r
  } catch {
    return { name: id, email: '' }
  }
}

/** Text that bots put in attachments and Block Kit instead of `text`. */
function extraText(m: any): string {
  const out: string[] = []
  const add = (s: unknown) => { if (typeof s === 'string' && s.trim()) out.push(s) }
  const blocks = (bs: any[]) => {
    for (const b of bs ?? []) {
      add(b?.text?.text)
      for (const f of b?.fields ?? []) add(f?.text)
      add(b?.accessory?.url)
      for (const el of b?.elements ?? []) { add(el?.text); add(el?.text?.text); add(el?.url) }
    }
  }
  for (const a of m?.attachments ?? []) {
    add(a.pretext)
    add(a.title && (a.title + (a.title_link ? ` <${a.title_link}>` : '')))
    add(a.text)
    for (const f of a.fields ?? []) add(`${f.title ?? ''}: ${f.value ?? ''}`)
    blocks(a.blocks)
  }
  blocks(m?.blocks)
  return out.join('\n')
}

function formatMessage(m: any): Record<string, unknown> {
  return {
    ts: m.ts,
    user: m.user ?? m.bot_id,
    ...(m.bot_profile?.name ? { bot_name: m.bot_profile.name } : {}),
    text: [m.text, extraText(m)].filter(Boolean).join('\n'),
    ...(m.thread_ts && m.thread_ts !== m.ts ? { thread_ts: m.thread_ts } : {}),
    ...(m.reply_count ? { reply_count: m.reply_count } : {}),
    ...(m.reactions?.length ? { reactions: m.reactions.map((r: any) => ({ name: r.name, count: r.count, users: r.users })) } : {}),
    ...(m.files?.length ? { files: m.files.map((f: any) => ({ id: f.id, name: f.name, size: f.size })) } : {}),
  }
}

async function threadContext(channel: string, thread: string, skipTs: string): Promise<string> {
  try {
    const res = await web.conversations.replies({ channel, ts: thread, limit: 100 })
    const prior = (res.messages ?? []).filter((m: any) => m.ts !== skipTs)
    if (!prior.length) return ''
    const lines = await Promise.all(prior.map(async (m: any) => {
      const who = m.bot_profile?.name ?? (m.user ? (await resolveUser(m.user)).name : 'unknown')
      return `[${new Date(Number(m.ts) * 1000).toISOString()}] ${who}: ${formatMessage(m).text}`
    }))
    return `[Earlier messages in this thread]\n${lines.join('\n')}\n[End of earlier messages]\n\n`
  } catch {
    return ''
  }
}

// ── Agent sessions ──────────────────────────────────────────────────────────

/** A message waiting for its turn, and where its thinking steps go, if anywhere. */
interface Queued {
  message: SDKUserMessage
  steps?: steps.Target
}

/**
 * A live agent session. Messages queue in its inbox and it gets them one turn at a
 * time: the next is handed over only when the turn ends, so a stop can still drop queued work.
 */
interface Session {
  query: Query
  inbox: Queued[]
  wake?: () => void
  turnDone?: () => void
  /** The current turn's thinking steps. */
  turn?: steps.Turn
}
const MAIN = 'main'
const sessions = new Map<string, Session>()

/**
 * Queue a message for the agent: a <slack ...> header with the metadata, then the content.
 * With a target, the turn's tool calls show there as thinking steps.
 */
function notify(content: string, meta: Record<string, string | undefined>, target?: steps.Target): void {
  const clean = Object.entries({ received_at: new Date().toISOString(), ...meta }).filter(([, v]) => v !== undefined && v !== '')
  const attrs = clean.map(([k, v]) => `${k}=\"${String(v).replaceAll('"', '&quot;')}\"`).join(' ')
  log('inbound', { meta: Object.fromEntries(clean), content: content.slice(0, 500) })
  const channel = meta.chat_id ?? ''
  const key = code.isCode(channel) ? channel : MAIN
  const session = sessions.get(key) ?? startSession(key)
  if (!session) {
    notify(`[BUSY] A message in code channel <#${channel}> is waiting: every world is in use. Tell them in that channel's origin thread or DM that it is queued.`, { chat_id: channel })
    return
  }
  session.inbox.push({
    message: { type: 'user', message: { role: 'user', content: `<slack ${attrs}>\n${content}\n</slack>` }, parent_tool_use_id: null },
    steps: target,
  })
  session.wake?.()
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
const clampLimit = (n: number | undefined) => Math.min(Math.max(1, n ?? 50), 200)

function allowedUploadPath(p: string): string {
  const real = realpathSync(p)
  if (![WORLDS_DIR, DOWNLOAD_DIR].some(dir => real.startsWith(realpathSync(dir) + '/'))) {
    throw new Error(`file_path must be under ${WORLDS_DIR} or ${DOWNLOAD_DIR}`)
  }
  return real
}

/** Wraps a handler so failures come back to the model as tool errors, and every call is logged. */
function slackTool<S extends z.ZodRawShape>(name: string, description: string, shape: S, run: (a: z.infer<z.ZodObject<S>>) => Promise<ReturnType<typeof text>>) {
  return tool(name, description, shape, async (a: any) => {
    try {
      const result = await run(a)
      log('tool', { name, args: a })
      return result
    } catch (err) {
      log('tool_error', { name, args: a, err: String(err) })
      return { ...text(`${name} failed: ${err instanceof Error ? err.message : err}`), isError: true }
    }
  }, { alwaysLoad: true })
}

const s = z.string()
// Each session gets its own MCP server instance built from these.
const slackTools = [
    slackTool('reply', 'Post a message (Slack mrkdwn). Pass thread_ts to reply in a thread. Returns the posted ts. In a code channel, set awaiting_answer when you asked a question you need answered before you can continue.', { chat_id: s, text: s, thread_ts: s.optional(), awaiting_answer: z.boolean().optional() }, async a => {
      const res = await web.chat.postMessage({ channel: a.chat_id, text: a.text, ...(a.thread_ts ? { thread_ts: a.thread_ts } : {}) })
      if (code.isCode(a.chat_id)) { if (a.awaiting_answer) code.waitForReply(a.chat_id) }
      else watch(a.chat_id, a.thread_ts ?? res.ts!)
      return text(`sent (ts: ${res.ts})`)
    }),
    slackTool('react', 'Add an emoji reaction, by name without colons.', { chat_id: s, message_id: s, emoji: s }, async a => {
      await web.reactions.add({ channel: a.chat_id, timestamp: a.message_id, name: a.emoji })
      return text('reacted')
    }),
    slackTool('edit', 'Edit a message the bot posted.', { chat_id: s, message_id: s, text: s }, async a => {
      await web.chat.update({ channel: a.chat_id, ts: a.message_id, text: a.text })
      return text('edited')
    }),
    slackTool('delete', 'Delete a message the bot posted.', { chat_id: s, message_id: s }, async a => {
      await web.chat.delete({ channel: a.chat_id, ts: a.message_id })
      return text('deleted')
    }),
    slackTool('read_history', 'Read recent messages in a conversation, newest first.', { chat_id: s, limit: z.number().optional(), oldest: s.optional(), latest: s.optional() }, async a => {
      const res = await web.conversations.history({ channel: a.chat_id, limit: clampLimit(a.limit), ...(a.oldest ? { oldest: a.oldest } : {}), ...(a.latest ? { latest: a.latest } : {}) })
      return text(JSON.stringify({ has_more: res.has_more, messages: (res.messages ?? []).map(formatMessage) }, null, 1))
    }),
    slackTool('read_replies', 'Read a thread, oldest first.', { chat_id: s, thread_ts: s, limit: z.number().optional() }, async a => {
      const res = await web.conversations.replies({ channel: a.chat_id, ts: a.thread_ts, limit: clampLimit(a.limit) })
      return text(JSON.stringify({ has_more: res.has_more, messages: (res.messages ?? []).map(formatMessage) }, null, 1))
    }),
    slackTool('get_user_info', 'Profile for a Slack user: name, email, timezone, status text/emoji/expiration.', { user_id: s }, async a => {
      const { user } = await web.users.info({ user: a.user_id }) as any
      const p = user?.profile ?? {}
      return text(JSON.stringify({ user_id: a.user_id, name: p.real_name ?? user?.name, email: p.email, title: p.title, tz: user?.tz, status_text: p.status_text, status_emoji: p.status_emoji, status_expiration: p.status_expiration }))
    }),
    slackTool('find_user_by_email', 'Slack user ID for an email address.', { email: s }, async a => {
      const { user } = await web.users.lookupByEmail({ email: a.email })
      return text(JSON.stringify({ user_id: user?.id, name: user?.profile?.real_name ?? user?.name }))
    }),
    slackTool('download_file', 'Download a Slack file by ID. Returns the local path.', { file_id: s }, async a => {
      const { file } = await web.files.info({ file: a.file_id })
      const url = file?.url_private_download ?? file?.url_private
      if (!url) throw new Error('no download URL')
      // Never send the bot token anywhere but Slack.
      const host = new URL(url)
      if (host.protocol !== 'https:' || !(host.hostname === 'slack.com' || host.hostname.endsWith('.slack.com'))) throw new Error(`not a Slack URL: ${host.hostname}`)
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${BOT_TOKEN}` } })
      if (!resp.ok) throw new Error(`download failed: ${resp.status}`)
      const path = join(DOWNLOAD_DIR, `${a.file_id}-${(file?.name ?? 'file').replace(/[^\w.-]/g, '_')}`)
      writeFileSync(path, Buffer.from(await resp.arrayBuffer()))
      return text(`path: ${path}`)
    }),
    slackTool('upload_file', `Upload a file to a channel or thread. file_path must be inside a world (${WORLDS_DIR}) or ${DOWNLOAD_DIR}; or pass content instead.`, { chat_id: s, filename: s, thread_ts: s.optional(), file_path: s.optional(), content: s.optional(), comment: s.optional() }, async a => {
      if (!a.file_path && a.content === undefined) throw new Error('pass file_path or content')
      const file = a.file_path ? readFileSync(allowedUploadPath(a.file_path)) : Buffer.from(a.content!)
      await web.filesUploadV2({ channel_id: a.chat_id, filename: a.filename, file, ...(a.thread_ts ? { thread_ts: a.thread_ts } : {}), ...(a.comment ? { initial_comment: a.comment } : {}) } as any)
      return text(`uploaded ${a.filename}`)
    }),
    slackTool('schedule_wake', 'Wake yourself about a thread at an absolute UTC time (ISO 8601). `name` (e.g. "escalation", "review", "recheck") lets a thread hold several wakes; scheduling the same name replaces it. Set until_reply_from to Slack user IDs to cancel it when one of them posts in the thread (an escalation clock); after_ts limits that to replies after your tag message.', { chat_id: s, thread_ts: s, name: s, fire_at: s, reason: s, until_reply_from: z.array(s).optional(), after_ts: s.optional() }, async a => {
      const fireAt = Date.parse(a.fire_at)
      if (Number.isNaN(fireAt)) throw new Error('fire_at must be ISO 8601')
      if (fireAt <= Date.now()) throw new Error(`fire_at is in the past (now ${new Date().toISOString()})`)
      wakes.schedule({ channel: a.chat_id, thread: a.thread_ts, name: a.name, fire_at: fireAt, reason: a.reason, until_reply_from: a.until_reply_from, after_ts: a.after_ts })
      watch(a.chat_id, a.thread_ts)
      return text(`"${a.name}" wake scheduled for ${new Date(fireAt).toISOString()}`)
    }),
    slackTool('cancel_wake', 'Cancel a named wake on a thread, or all of its wakes if name is omitted.', { chat_id: s, thread_ts: s, name: s.optional() }, async a =>
      text(`cancelled ${wakes.cancel(a.chat_id, a.thread_ts, a.name)} wake(s)`)),
    slackTool('open_code_channel', 'Open a code channel for a task and hand the task to it. Slack invites the asker, lets the origin channel\'s members join, and links it from the origin thread. A separate session of you picks up the task there with the request and its thread; you are done with it after this call.', { chat_id: s, message_id: s, request: s, name: s.optional() }, async a => {
      if (code.isCode(a.chat_id)) throw new Error('already in a code channel: do the work here')
      if (liveCodeSessions() >= config.worlds) throw new Error(`all ${config.worlds} worlds are busy with other code channels: tell the asker it is queued and offer to start it later`)
      const res = await code.call('agents.conversations.create', { session_id: `${a.chat_id}:${a.message_id}`, origin_channel_id: a.chat_id, origin_message_ts: a.message_id, ...(a.name ? { name: a.name } : {}) })
      code.remember(res.channel_id)
      const history = await threadContext(a.chat_id, a.message_id, '')
      notify(`[TASK] Opened from <#${a.chat_id}> (message ${a.message_id}). Do this task here.\n\n${history}${a.request}`, { chat_id: res.channel_id, code_channel: 'true', origin_chat_id: a.chat_id, origin_message_id: a.message_id }, { channel: res.channel_id })
      return text(`code channel ${res.channel_id} opened and the task handed off. Post nothing more about it here.`)
    }),
    slackTool('update_code_channel', 'Update a code channel. context_bar replaces the pinned items (max 5: repo, branch, PR, CI...). world publishes the diff of every repo in that claimed world against main to the Code tab.', {
      chat_id: s,
      context_bar: z.array(z.object({ key: s, label: s, icon: z.enum(['branch', 'folder', 'hierarchy', 'life-ring', 'link', 'globe', 'terminal', 'code', 'search', 'lock']).optional(), url: s.optional() })).max(5).optional(),
      world: s.optional(),
    }, async a => {
      if (!a.context_bar && !a.world) throw new Error('pass context_bar or world')
      if (a.context_bar) await code.call('agents.conversations.setProperties', { channel_id: a.chat_id, code_channel: { context_bar_items: a.context_bar } })
      if (a.world) {
        const { diff, branch } = code.worldDiff(a.world)
        if (!diff) throw new Error('no changes in that world yet')
        await code.call('agents.conversations.setView', { channel_id: a.chat_id, type: 'diff', content: diff, base_branch: 'main', head_branch: branch })
      }
      return text('updated')
    }),
    slackTool('close_code_channel', 'Archive a code channel when its work is done or abandoned. summary_ts is your wrap-up message in the channel. Release its world first.', { chat_id: s, summary_ts: s }, async a => {
      // An archived channel refuses edits, so the turn's thinking steps get their final title first.
      const session = sessions.get(a.chat_id)
      await session?.turn?.end(true)
      if (session) session.turn = undefined
      await code.call('agents.conversations.archive', { channel_id: a.chat_id, summary_message_ts: a.summary_ts })
      // The session is ended below before its turn finishes, so endTurn never gets to clear "processing".
      code.close(a.chat_id)
      // This session's own tool call: let the call return before ending it.
      setTimeout(() => endSession(a.chat_id), 2000)
      return text('archived. This session ends now.')
    }),
]

const SLACK_RULES = `
# Slack bridge
You run unattended. Nobody reads your transcript: people only see what you post with the slack tools.
Each turn is a message wrapped in <slack chat_id thread_ts message_id user user_id received_at is_engineer|is_bot ...>.
Reply in the thread: pass chat_id and thread_ts from the message. Threads you post in are watched, so follow-ups reach you without an @mention.
In a code channel (code_channel="true") every message is a turn, mentioned or not. Reply top-level there unless the message was in a thread. The bridge sets the channel's working/idle status for you.
Each code channel has its own session of you, which only sees that channel. The main session handles everything else.
Wakes from the bridge itself start with [ALERT], [ALERT RESOLVED], [WAKE], [CRON], [TASK] (a code channel's first turn) or [BUSY]. A [CRON] has no thread: post top-level in its chat_id.
If a message needs no reply, end the turn without posting.
For engineers, in code channels and on alerts, the bridge shows your tool calls as thinking steps: a message titled "Working…", then "Worked for …" or "Stopped after …". It is not a reply from you; leave it alone.`

// ── Inbound ─────────────────────────────────────────────────────────────────

async function onMessage(ev: any): Promise<void> {
  if (ev.user === botUserId || (ev.bot_id && ev.bot_id === botBotId)) return
  const isBot = !!ev.bot_id
  const allowedSubtypes = isBot ? [undefined, 'bot_message'] : [undefined, 'file_share', 'thread_broadcast']
  if (!allowedSubtypes.includes(ev.subtype)) return
  const channel: string = ev.channel
  const thread: string | undefined = ev.thread_ts
  const body = [ev.text ?? '', extraText(ev)].filter(Boolean).join('\n')

  const alertCfg = config.alerts[channel]
  if (isBot && alertCfg?.posters.includes(ev.bot_id) && alerts.handleAlert(ev, body, alertCfg)) return
  if (isBot && !config.bots[ev.bot_id]) return

  if (!isBot && thread) wakes.notifyReply(channel, thread, ev.user, ev.ts)

  const mentioned = !!botUserId && (ev.text ?? '').includes(`<@${botUserId}>`)
  const isTicket = isBot && !thread && !!config.tickets[channel]?.posters.includes(ev.bot_id)
  const isDirect = ev.channel_type === 'im' || ev.channel_type === 'mpim'
  const isDM = ev.channel_type === 'im'
  const root = thread ?? ev.ts
  const isWatched = !!thread && watched.has(`${channel}:${thread}`)
  const inCode = code.isCode(channel) || (mentioned && !isDirect && await isCodeChannel(channel))
  if (!(isDirect || mentioned || isTicket || isWatched || inCode)) return
  if (!claim(`${channel}:${ev.ts}`)) return

  const firstSee = !watched.has(`${channel}:${root}`)
  if (!inCode && (!isDM || thread)) watch(channel, root)
  if (mentioned && !isBot) alerts.notifyMention(channel, root)

  const who = isBot ? { name: ev.bot_profile?.name ?? ev.bot_id, email: '' } : await resolveUser(ev.user)
  const context = firstSee && thread && !inCode ? await threadContext(channel, thread, ev.ts) : ''
  const content = body.replaceAll(`<@${botUserId}>`, '').trim()
  const files = (ev.files ?? []).map((f: any) => `[file: ${f.name} (${f.mimetype}, ${f.size} bytes, id: ${f.id})]`).join('\n')

  const replyThread = (isDM || inCode) && !thread ? undefined : root
  // Steps name files and commands, so only engineers see them (and everyone in a code channel, where the work happens).
  const showSteps = inCode || (!isBot && engineers.has(who.email))
  notify(context + (content || '(no text)') + (files ? `\n\n${files}` : ''), {
    chat_id: channel,
    thread_ts: replyThread,
    ...(inCode ? { code_channel: 'true' } : {}),
    message_id: ev.ts,
    user: who.name,
    user_id: isBot ? ev.bot_id : ev.user,
    ...(isBot ? { is_bot: 'true' } : { user_email: who.email, is_engineer: String(engineers.has(who.email)) }),
    ...(isTicket ? { source: 'ticket' } : {}),
    received_at: new Date(Number(ev.ts) * 1000).toISOString(),
  }, showSteps ? { channel, thread_ts: replyThread } : undefined)
}

/** A code channel someone else opened (e.g. from Slack's UI) and then mentioned the bot in. */
const notCode = new Set<string>()
async function isCodeChannel(channel: string): Promise<boolean> {
  if (notCode.has(channel)) return false
  try {
    const { channel: info } = await web.conversations.info({ channel }) as any
    if (info?.properties?.record_channel?.record_type === 'agent_channel') { code.remember(channel); return true }
  } catch (err) { log('code_check_error', { channel, err: String(err) }) }
  notCode.add(channel)
  return false
}

// Someone pressed stop in a code channel: drop its queued messages and interrupt its turn.
slack.event('agent_session_stopped', async ({ event }: any) => {
  const channel: string = event.channel
  const session = sessions.get(channel)
  log('code_stopped', { channel, live: !!session })
  code.stop(channel)
  if (!session) return
  session.inbox.length = 0
  await session.query.interrupt().catch(err => log('interrupt_error', { channel, err: String(err) }))
})

slack.message(async ({ message }) => {
  try { await onMessage(message) } catch (err) { log('handler_error', { err: String(err) }) }
})

// ── Start ───────────────────────────────────────────────────────────────────

alerts.init({
  react: (channel, ts, emoji) => { web.reactions.add({ channel, timestamp: ts, name: emoji }).catch(() => {}) },
  watch,
  wake: (content, meta) => notify(content, meta, { channel: meta.chat_id, thread_ts: meta.thread_ts }),
  debug: msg => log('alerts', { msg }),
})
code.init(msg => log('code', { msg }))
steps.init({
  post: async (target, message) => {
    const { ts } = await web.chat.postMessage({ channel: target.channel, ...(target.thread_ts ? { thread_ts: target.thread_ts } : {}), ...message })
    if (!ts) throw new Error('chat.postMessage returned no ts')
    return ts
  },
  update: async (channel, ts, message) => { await web.chat.update({ channel, ts, ...message }) },
  debug: msg => log('steps', { msg }),
})
wakes.init(w => notify(`[WAKE] ${w.reason}`, { chat_id: w.channel, thread_ts: w.thread, wake: w.name }))
for (const job of config.crons) {
  Bun.cron(job.schedule, () => notify(`[CRON ${job.name}] ${job.prompt}`, { chat_id: job.channel, cron: job.name }), { tz: config.timezone })
}
await slack.start()
const auth = await web.auth.test()
botUserId = auth.user_id!
botBotId = auth.bot_id!
log('started', { team: config.name, bot_user: auth.user, alert_channels: Object.keys(config.alerts).length, crons: config.crons.length })

// Expand ${VAR} in the config's MCP servers from the container env.
const agentEnv = providerEnv(config.model, process.env)
const toolServers = JSON.parse(JSON.stringify(config.tools).replace(/\$\{(\w+)\}/g, (_, v) => process.env[v] ?? ''))
const browserServer = config.browser
  ? { browser: await browser.start({ outputDir: join(DOWNLOAD_DIR, 'browser'), onDeny: (host, port) => log('egress_denied', { host, port }) }) }
  : {}

// The main session keeps one ID across restarts, unless asked for a fresh one.
const MAIN_FILE = join(STATE_DIR, 'main-session.json')
const FRESH_FLAG = join(DATA_DIR, 'fresh')
if (existsSync(FRESH_FLAG)) { writeJson(MAIN_FILE, {}); Bun.file(FRESH_FLAG).delete() }
const mainId = readJson<{ id?: string }>(MAIN_FILE, {}).id ?? randomUUID()
writeJson(MAIN_FILE, { id: mainId })

const historyDir = join(process.env.HOME ?? '', '.claude', 'projects')
const hasHistory = (id: string) => existsSync(historyDir) && readdirSync(historyDir, { recursive: true }).some(f => String(f).endsWith(`${id}.jsonl`))
const liveCodeSessions = () => [...sessions.keys()].filter(k => k !== MAIN).length

/** Start (or resume) the session for `key`: MAIN, or a code channel ID. Returns undefined when every world is taken. */
function startSession(key: string): Session | undefined {
  if (key !== MAIN && liveCodeSessions() >= config.worlds) return undefined
  const id = key === MAIN ? mainId : code.sessionId(key)!
  const resume = hasHistory(id)
  const session: Session = { inbox: [], query: undefined as unknown as Query }
  async function* turns(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      while (!session.inbox.length) await new Promise<void>(r => { session.wake = r })
      if (key !== MAIN) code.startTurn(key)
      const done = new Promise<void>(r => { session.turnDone = r })
      const next = session.inbox.shift()!
      session.turn = next.steps && steps.begin(next.steps)
      yield next.message
      await done
    }
  }
  session.query = query({
    prompt: turns(),
    options: {
      cwd: SESSION_DIR,
      model: config.model.name,
      env: agentEnv,
      settingSources: ['project'], // CLAUDE.md and .claude/skills in the session dir
      systemPrompt: { type: 'preset', preset: 'claude_code', append: SLACK_RULES + (key === MAIN ? '' : `\nThis session is code channel ${key}.`) },
      mcpServers: { slack: createSdkMcpServer({ name: 'slack', tools: slackTools }), ...browserServer, ...toolServers },
      allowedTools: ['mcp__slack'],
      disallowedTools: browser.DISALLOWED_TOOLS,
      skills: 'all',
      permissionMode: 'auto',
      settings: { attribution: false }, // CLAUDE.md owns commit and PR format
      // Nobody is at a terminal to approve what the auto-mode classifier can't decide.
      canUseTool: async (toolName, input) => {
        log('tool_denied', { session: key, tool: toolName, input })
        return { behavior: 'deny', message: 'Not approved: no human can confirm this. Ask an engineer in the thread to run it, or do it another way.' }
      },
      ...(resume ? { resume: id } : { sessionId: id }),
      stderr: line => log('agent_stderr', { session: key, line }),
    },
  })
  sessions.set(key, session)
  log('session', { session: key, id, resume })
  run(key, session)
  return session
}

async function run(key: string, session: Session): Promise<void> {
  try {
    for await (const m of session.query) {
      if (m.type === 'system' && m.subtype === 'init') log('agent_init', { session: key, model: m.model, tools: m.tools.length, mcp: m.mcp_servers })
      if (m.type === 'assistant') for (const call of steps.toolCalls(m.message.content)) session.turn?.start(call)
      if (m.type === 'user') for (const r of steps.toolResults(m.message.content)) session.turn?.finish(r.id, r.failed)
      if (m.type === 'result') {
        void session.turn?.end(m.subtype === 'success')
        session.turn = undefined
        if (key !== MAIN) code.endTurn(key)
        session.turnDone?.()
        log('turn', { session: key, subtype: m.subtype, turns: m.num_turns, cost_usd: m.total_cost_usd, ...(m.subtype !== 'success' ? { errors: m.errors } : {}) })
      }
    }
    log('agent_ended', { session: key })
  } catch (err) {
    log('agent_failed', { session: key, err: String(err) })
  }
  void session.turn?.end(false)
  session.turn = undefined
  if (sessions.get(key) !== session) return // ended on purpose
  sessions.delete(key)
  // The main session should never end; exit so the orchestrator restarts the container.
  if (key === MAIN) process.exit(1)
}

function endSession(key: string): void {
  const session = sessions.get(key)
  if (!session) return
  sessions.delete(key)
  session.query.close()
  log('session_closed', { session: key })
}

startSession(MAIN)

const shutdown = async () => {
  for (const s of sessions.values()) s.query.close()
  try { await slack.stop() } catch {}
  process.exit(0)
}
process.on('SIGTERM', shutdown)
