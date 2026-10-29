/**
 * Thinking steps: while the agent works on a turn, a message with a Slack plan
 * block lists its tool calls with their status, in the conversation the reply
 * goes to. It's posted with chat.postMessage and kept current with chat.update,
 * not streamed: a stream ends after 10 minutes, needs a recipient in channels and
 * can't be top-level in a DM, and turns here run long, top-level, and unattended.
 *
 * The message only appears once the agent does real work. A turn that just reads
 * Slack and stays quiet (most messages in a watched thread) posts nothing.
 */

import { z } from 'zod'
import { WORLDS_DIR } from './config.ts'

/** The conversation a turn's reply goes to. No thread_ts means top-level: a DM or a code channel. */
export interface Target {
  channel: string
  thread_ts?: string
}

type Status = 'in_progress' | 'complete' | 'error'
type RichText = { type: 'rich_text'; elements: { type: 'rich_text_preformatted'; elements: { type: 'text'; text: string }[] }[] }
type Source = { type: 'url'; url: string; text: string }

interface Task {
  task_id: string
  title: string
  status: Status
  details?: RichText
  sources?: Source[]
}

export interface PlanMessage {
  text: string
  blocks: [{ type: 'plan'; title: string; tasks: Task[] }]
}

export interface Deps {
  /** Posts the plan message and returns its ts. */
  post(target: Target, message: PlanMessage): Promise<string>
  update(channel: string, ts: string, message: PlanMessage): Promise<void>
  debug(msg: string): void
  /** Minimum gap between chat.update calls; Slack asks for one every 3 seconds. */
  intervalMs?: number
}

let deps: Deps = { post: async () => '', update: async () => {}, debug: () => {} }
export function init(d: Deps): void {
  deps = d
}

// ── What each tool call looks like as a step ────────────────────────────────

export interface Step {
  /** `lookup` steps show, but don't post the message on their own. */
  kind: 'work' | 'lookup'
  title: string
  details?: string
  sources?: Source[]
}

const SLACK = 'mcp__slack__'
const LOOKUPS: Record<string, string> = {
  read_history: 'Reading channel history',
  read_replies: 'Reading the thread',
  get_user_info: 'Looking up a person',
  find_user_by_email: 'Looking up a person',
  download_file: 'Downloading a file',
}
/** Claude Code bookkeeping with nothing worth showing. */
const INTERNAL: Record<string, true> = { ToolSearch: true, TodoWrite: true, TaskCreate: true, TaskUpdate: true, TaskGet: true, TaskList: true, TaskStop: true, ListAgents: true }

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
/** A path inside a world, shown from the repo down: /data/worlds/2/api/src/x.ts → api/src/x.ts. */
const inWorld = (p: string) => (p.startsWith(WORLDS_DIR + '/') ? p.slice(WORLDS_DIR.length + 1).replace(/^\d+\//, '') : p)
/** A web page as a step label, with a link when the URL parses. */
function page(url: unknown): { label: string; sources?: Source[] } {
  const u = str(url)
  const host = u && URL.canParse(u) ? new URL(u).hostname : undefined
  return u && host ? { label: host, sources: [{ type: 'url', url: u, text: host }] } : { label: 'a web page' }
}

const BROWSER = 'mcp__browser__browser_'

/** A tool call as a step, or undefined when it isn't one: Slack actions people already see, and bookkeeping. */
export function describe(name: string, input: Record<string, unknown>): Step | undefined {
  if (name.startsWith(SLACK)) {
    const title = LOOKUPS[name.slice(SLACK.length)]
    return title ? { kind: 'lookup', title } : undefined
  }
  if (INTERNAL[name]) return undefined
  if (name.startsWith(BROWSER)) {
    const action = name.slice(BROWSER.length)
    const element = str(input.element)
    switch (action) {
      case 'navigate': {
        const { label, sources } = page(input.url)
        return { kind: 'work', title: `Opening ${label}`, ...(sources ? { sources } : {}) }
      }
      case 'click': return { kind: 'work', title: `Clicking ${element ?? 'on the page'}` }
      // Never what was typed: it can be anything.
      case 'type':
      case 'fill_form': return { kind: 'work', title: `Typing into ${element ?? 'a form'}` }
      case 'snapshot': return { kind: 'work', title: 'Reading the page' }
      case 'take_screenshot': return { kind: 'work', title: 'Taking a screenshot' }
      default: return { kind: 'work', title: `Browser: ${action.replaceAll('_', ' ')}` }
    }
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  if (mcp) return { kind: 'work', title: `${mcp[1]}: ${mcp[2]}` }
  const path = str(input.file_path) ?? str(input.notebook_path)
  switch (name) {
    case 'Bash': {
      const command = str(input.command) ?? ''
      return { kind: 'work', title: str(input.description) ?? command.split('\n')[0], details: command }
    }
    case 'Read': return { kind: 'work', title: `Reading ${path ? inWorld(path) : 'a file'}` }
    case 'Edit':
    case 'NotebookEdit': return { kind: 'work', title: `Editing ${path ? inWorld(path) : 'a file'}` }
    case 'Write': return { kind: 'work', title: `Writing ${path ? inWorld(path) : 'a file'}` }
    case 'Grep': return { kind: 'work', title: `Searching for ${str(input.pattern) ?? 'a pattern'}` }
    case 'Glob': return { kind: 'work', title: `Finding ${str(input.pattern) ?? 'files'}` }
    case 'WebSearch': return { kind: 'work', title: `Searching the web for "${str(input.query) ?? ''}"` }
    case 'WebFetch': {
      const { label, sources } = page(input.url)
      return { kind: 'work', title: `Reading ${label}`, ...(sources ? { sources } : {}) }
    }
    case 'Task':
    case 'Agent': return { kind: 'work', title: `Subagent: ${str(input.description) ?? 'working'}` }
    case 'Skill': return { kind: 'work', title: `Using the ${str(input.skill) ?? str(input.name) ?? ''} skill` }
    default: return { kind: 'work', title: name }
  }
}

/** Tokens that must never reach Slack, even inside a command line. */
const SECRET = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|xox[abeprs]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|sk-ant-[\w-]{10,}|AKIA[0-9A-Z]{16})\b/g

/** Redacts known token shapes and cuts the text to `max` characters. */
function sanitize(s: string, max: number): string {
  const clean = s.replace(SECRET, '[REDACTED]')
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean
}

// ── Reading tool calls and results out of agent messages ────────────────────

const ToolUse = z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.record(z.string(), z.unknown()) })
const ToolResult = z.object({ type: z.literal('tool_result'), tool_use_id: z.string(), is_error: z.boolean().optional() })

export interface ToolCall { id: string; name: string; input: Record<string, unknown> }

/** The tool calls in an assistant message's content. */
export function toolCalls(content: unknown): ToolCall[] {
  if (!Array.isArray(content)) return []
  return content.flatMap(b => {
    const r = ToolUse.safeParse(b)
    return r.success ? [{ id: r.data.id, name: r.data.name, input: r.data.input }] : []
  })
}

/** The tool results in a user message's content. */
export function toolResults(content: unknown): { id: string; failed: boolean }[] {
  if (!Array.isArray(content)) return []
  return content.flatMap(b => {
    const r = ToolResult.safeParse(b)
    return r.success ? [{ id: r.data.tool_use_id, failed: r.data.is_error === true }] : []
  })
}

// ── One turn's plan message ─────────────────────────────────────────────────

/** A plan block holds at most 50 tasks; older ones fold into a single line. */
const MAX_TASKS = 50

export interface Turn {
  start(call: ToolCall): void
  finish(id: string, failed: boolean): void
  /** The turn is over: give the message its final title and statuses. Resolves once it's sent. */
  end(ok: boolean): Promise<void>
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

export function begin(target: Target): Turn {
  const startedAt = Date.now()
  const interval = deps.intervalMs ?? 3000
  const tasks = new Map<string, Task>()
  let shown = false // a work step has happened, so the message exists or is on its way
  let ts: string | undefined
  let failed = false // Slack refused the message; stop trying for this turn
  let outcome: 'working' | 'done' | 'stopped' = 'working'
  let dirty = false
  let timer: Timer | undefined
  let sending: Promise<void> | undefined
  let sentAt = 0

  function render(): PlanMessage {
    const title = outcome === 'working' ? 'Working…'
      : `${outcome === 'done' ? 'Worked for' : 'Stopped after'} ${duration(Date.now() - startedAt)}`
    let list = [...tasks.values()]
    if (list.length > MAX_TASKS) {
      const folded = list.slice(0, list.length - (MAX_TASKS - 1))
      list = [
        { task_id: 'earlier', title: `${folded.length} earlier steps`, status: folded.some(t => t.status === 'in_progress') ? 'in_progress' : 'complete' },
        ...list.slice(folded.length),
      ]
    }
    return { text: title, blocks: [{ type: 'plan', title, tasks: list }] }
  }

  async function send(): Promise<void> {
    const message = render()
    try {
      if (ts === undefined) ts = await deps.post(target, message)
      else await deps.update(target.channel, ts, message)
    } catch (err) {
      failed = true
      deps.debug(`thinking steps in ${target.channel}: ${err}`)
    }
  }

  async function pump(): Promise<void> {
    timer = undefined
    if (!dirty || failed || outcome !== 'working') return
    dirty = false
    sending = send()
    await sending
    sending = undefined
    sentAt = Date.now()
    if (dirty) schedule()
  }

  function schedule(): void {
    dirty = true
    if (!shown || sending || timer || failed || outcome !== 'working') return
    timer = setTimeout(pump, Math.max(0, sentAt + interval - Date.now()))
  }

  return {
    start(call) {
      if (outcome !== 'working') return
      const step = describe(call.name, call.input)
      if (!step) return
      tasks.set(call.id, {
        task_id: call.id,
        title: sanitize(step.title, 150),
        status: 'in_progress',
        ...(step.details ? { details: { type: 'rich_text', elements: [{ type: 'rich_text_preformatted', elements: [{ type: 'text', text: sanitize(step.details, 1000) }] }] } } : {}),
        ...(step.sources ? { sources: step.sources } : {}),
      })
      if (step.kind === 'work') shown = true
      schedule()
    },
    finish(id, toolFailed) {
      const task = tasks.get(id)
      if (!task || outcome !== 'working') return
      task.status = toolFailed ? 'error' : 'complete'
      schedule()
    },
    async end(ok) {
      if (outcome !== 'working') return
      outcome = ok ? 'done' : 'stopped'
      clearTimeout(timer)
      timer = undefined
      for (const task of tasks.values()) if (task.status === 'in_progress') task.status = ok ? 'complete' : 'error'
      await sending
      if (shown && !failed) await send()
    },
  }
}
