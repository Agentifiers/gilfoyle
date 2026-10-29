import { afterAll, beforeEach, expect, test } from 'bun:test'
import { execSync } from 'child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

process.env.GILFOYLE_DATA = mkdtempSync(join(tmpdir(), 'gilfoyle-'))
const calls: { method: string; body: any }[] = []
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    calls.push({ method: new URL(req.url).pathname.slice(1), body: await req.json() })
    return Response.json({ ok: true })
  },
})
process.env.SLACK_API_URL = `http://127.0.0.1:${server.port}/`
const code = await import('./code.ts')
const { WORLDS_DIR } = await import('./config.ts')
afterAll(() => server.stop())

const statuses = async () => {
  await Bun.sleep(20)
  return calls.splice(0).filter(c => c.method === 'agents.sessions.setStatus').map(c => `${c.body.channel_id}:${c.body.status}`)
}

beforeEach(async () => {
  for (const c of ['C1', 'C2']) { code.forget(c); code.remember(c) }
  await statuses()
})

test('a question keeps the channel suspended past the end of the turn, until the answer arrives', async () => {
  code.startTurn('C1')
  code.waitForReply('C1')
  code.endTurn('C1')
  code.startTurn('C1') // the answer
  code.endTurn('C1')
  expect(await statuses()).toEqual(['C1:processing', 'C1:suspended', 'C1:processing', 'C1:active'])
})

test('archiving mid-turn closes the session, and the turn ending late does not reopen it', async () => {
  code.startTurn('C1')
  code.close('C1')
  code.endTurn('C1')
  expect(await statuses()).toEqual(['C1:processing', 'C1:closed'])
  expect(code.isCode('C1')).toBe(false)
})

test('each code channel keeps its own session ID across a restart', () => {
  const id = code.sessionId('C1')
  code.remember('C1')
  code.init(() => {})
  expect(code.sessionId('C1')).toBe(id!)
  expect(code.sessionId('C2')).not.toBe(id!)
})

test('worldDiff covers every repo in the world, prefixed by repo, against the merge base', () => {
  const world = join(WORLDS_DIR, '1')
  const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  for (const repo of ['api', 'web']) {
    const dir = join(world, repo)
    mkdirSync(dir, { recursive: true })
    sh('git init -q -b main && echo base > f.txt && git add . && git commit -qm base && git update-ref refs/remotes/origin/main HEAD && git checkout -qb task', dir)
  }
  // api: a commit on the task branch, then main moves on; main's change must not show up.
  sh('echo mine > f.txt && git commit -qam mine && git checkout -q main && echo theirs > g.txt && git add . && git commit -qm theirs && git update-ref refs/remotes/origin/main HEAD && git checkout -q task', join(world, 'api'))
  // web: an uncommitted edit counts too. Neither should leak into the other's paths.
  writeFileSync(join(world, 'web', 'f.txt'), 'wip\n')
  const { diff, branch } = code.worldDiff(world)
  expect(branch).toBe('task')
  expect(diff).toContain('diff --git a/api/f.txt b/api/f.txt')
  expect(diff).toContain('+mine')
  expect(diff).toContain('diff --git a/web/f.txt b/web/f.txt')
  expect(diff).toContain('+wip')
  expect(diff).not.toContain('g.txt')
})

test('worldDiff refuses paths outside the worlds dir', () => {
  expect(() => code.worldDiff(tmpdir())).toThrow(/must be under/)
})
