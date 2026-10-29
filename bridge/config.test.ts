import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const { loadConfig, providerEnv } = await import('./config.ts')

test('the shipped gilfoyle.yaml loads', () => {
  expect(loadConfig().github.repos.length).toBeGreaterThan(0)
})

test('a bad cron schedule fails at load, not at 9am', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'gilfoyle-')), 'gilfoyle.yaml')
  writeFileSync(file, `
name: t
owner: a@x.com
timezone: UTC
model: { provider: anthropic, name: claude-opus-5-5 }
github: { org: o, repos: [{ name: r }] }
members: []
crons: [{ name: daily, schedule: "every day", channel: C1, prompt: hi }]
`)
  expect(() => loadConfig(file)).toThrow(/crons\.daily/)
})

test('the configured provider wins over provider vars left in the container env', () => {
  const env = { PATH: '/bin', CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_MODEL: 'stale', ANTHROPIC_API_KEY: 'k' }
  const anthropic = providerEnv({ provider: 'anthropic', name: 'claude-opus-5-5', base_url: 'http://gw:8317' }, env)
  expect(anthropic).toMatchObject({ PATH: '/bin', ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'http://gw:8317' })
  expect(anthropic.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
  expect(anthropic.ANTHROPIC_MODEL).toBeUndefined()
  const bedrock = providerEnv({ provider: 'bedrock', name: 'global.anthropic.claude-opus-5-5', region: 'eu-west-1' }, { ANTHROPIC_BASE_URL: 'http://gw' })
  expect(bedrock).toEqual({ CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'eu-west-1' })
})
