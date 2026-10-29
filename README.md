<p align="center">
  <img src="docs/gilfoyle.jpeg" alt="Gilfoyle" width="240"/>
</p>

# Gilfoyle

A Slack-invoked engineering assistant for one team. People @mention it to triage bugs and alerts, and it opens small PRs. It runs in one container. A Bun process holds the Slack connection and drives Claude Agent SDK sessions on Amazon Bedrock or the Anthropic API.

```
Slack ──Socket Mode──▶ bridge ──messages──▶ Agent SDK session ──▶ Bedrock or Anthropic API
                         │  ◀──Slack tools──     │
                         │                       └──▶ gh, git, ticket tracker MCP
                         └── alerts, wakes, crons ── /data volume: state, worlds, session history
```

## Layout

| Path | What |
|---|---|
| `gilfoyle.yaml` | **The one config file**: model, team members, repos, tools, alerts, crons, notes |
| `CLAUDE.md` | How the bot behaves. The Team section is generated from `gilfoyle.yaml` at startup |
| `skills/` | Optional team skills, one directory per skill |
| `bridge/` | Slack ⇄ agent bridge: inbound routing, Slack tools, code channels, alert holdoff, scheduled wakes, crons |
| `bin/` | Container entrypoint, `claim-world.sh`, `release-world.sh`, `restart.sh` |
| `deploy/` | Kubernetes manifest, Bedrock IAM policy, Slack app manifest |

## Set up

1. Edit `gilfoyle.yaml`.
2. Create a Slack app from `deploy/slack-manifest.yaml` and invite it to your channels.
3. Build and deploy, as described in `deploy/gilfoyle.yaml`:
   ```bash
   docker build -t <registry>/gilfoyle:<tag> .
   ```
4. @mention the bot to check it answers.

To run it without Kubernetes, on any Linux box with Docker and an instance role:

```bash
docker run -d --restart unless-stopped --name gilfoyle \
  --env-file gilfoyle.env -v gilfoyle:/data <registry>/gilfoyle:<tag>
```

## `gilfoyle.yaml`

| Key | Meaning |
|---|---|
| `name`, `owner` | Team name, and the email that hears about refusals |
| `model` | `provider` (`bedrock` or `anthropic`) and `name`. Bedrock also needs `region`. Anthropic takes an optional `base_url` for a gateway |
| `timezone`, `holidays` | Crons run in `timezone`, and escalation uses it for people with no Slack timezone. No one is tagged on `holidays` |
| `github` | `org`, and the `repos` cloned into each world, each with an optional `setup` command run on claim |
| `worlds` | How many parallel working copies to allow (default 3) |
| `browser` | Headless Chromium for the agent (default `true`). See "Browser" below |
| `members` | `email`, `name`, `engineer: true` to direct write actions, `escalation: true` to be tagged on alerts |
| `bots` | Bot IDs whose messages reach Gilfoyle, with a label. Other bots are ignored, except alert `posters` |
| `alerts` | Alert channels: `source`, `posters` (the bot IDs that post alerts there), optional `env` and `ignore` (name globs) |
| `tickets` | Channels where a listed bot's top-level posts wake Gilfoyle, e.g. a support feed |
| `tools` | MCP servers, e.g. the ticket tracker. `${VAR}` reads from the container env |
| `crons` | `name`, `schedule` (five-field cron), `channel`, `prompt`. Gilfoyle gets the prompt at that time and works in the channel |
| `notes` | Anything else Gilfoyle should know, appended to CLAUDE.md |

**Alert sources.** `cloudwatch`, `datadog` and `incidentio` are built in (`bridge/alerts.ts`). For anything else, give a regex instead of a name:

```yaml
source: { pattern: "^(?<state>PROBLEM|RECOVERY): (?<name>.+)", firing: PROBLEM, resolved: RECOVERY }
```

**Ticket trackers.** Add the tracker's MCP server under `tools` with an API key header. `gilfoyle.yaml` has Jira and Linear examples. For Jira, `JIRA_AUTH` is base64 of `email:api_token`, and an Atlassian admin has to allow API-token auth for the Rovo MCP server.

## Model access

Set in `gilfoyle.yaml` under `model`.

- **Bedrock** (the default): `global.anthropic.claude-opus-5-5`, or a `us.`, `eu.`, `au.` or `jp.` regional profile. The pod needs an AWS role carrying `deploy/bedrock-policy.json`. On EKS, use Pod Identity (see `deploy/gilfoyle.yaml`). On EC2, use the instance role. Opus 5.5 must be enabled in the account's Bedrock model access page.
- **Anthropic API**: `provider: anthropic`, `name: claude-opus-5-5`, and `ANTHROPIC_API_KEY` in the secret. `base_url` points it at any gateway that speaks the Anthropic Messages API instead, such as CLIProxyAPI for testing; use `ANTHROPIC_AUTH_TOKEN` if the gateway wants a bearer token.

## Secrets

The container reads `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `GH_TOKEN`, `ANTHROPIC_API_KEY` for the Anthropic provider, (a fine-grained token or GitHub App token with contents and pull-request write on your repos), and any variable `tools` references.

Commits are authored as the GitHub account `GH_TOKEN` belongs to, the same account that pushes and opens the PRs. A GitHub App token has no user to look up, so set `GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL` with it, e.g. the app's `<bot user id>+<app slug>[bot]@users.noreply.github.com`. Without them the container won't start.

## Things to know

- **Code work happens in [code channels](https://docs.slack.dev/ai/slack-code/).** When a request needs code changes, Gilfoyle opens a channel for it with a status, a context bar (repo, branch, PR, CI) and a diff tab, works there, and archives it with a summary. The manifest turns this on (`code_channels`, `code_channels:manage`, `agent_session_stopped`). Pressing stop drops that channel's queued messages and interrupts its turn.
- **Thinking steps.** For engineers, in code channels and on alerts, Gilfoyle posts a [plan](https://docs.slack.dev/reference/block-kit/blocks/plan-block/) where its reply goes, listing each tool call (commands, files read and edited, lookups) as it runs, and retitles it "Worked for 1m 5s" when the turn ends. It appears only once real work starts, so a turn that just reads Slack and stays quiet posts nothing. Everyone else gets no steps, since they name files and commands. The plan is posted and then updated at most every 3 seconds rather than streamed, because turns can outlast Slack's 10-minute stream limit.
- **One agent session per code channel.** Code channels run in parallel, each with its own conversation, up to `worlds` at once. A main session handles DMs, threads, alerts and crons. Each session is its own Claude Code process (about 200 MB each, measured idle), so size the pod's memory to `worlds + 1`.
- **Run exactly one replica.** Slack spreads events across every open connection, and crons would fire twice.
- **Permissions run in auto mode.** Claude Code's classifier allows routine actions. Anything it would ask a human about is denied and logged as `tool_denied` in `/data/bridge.log`.
- **No WebSearch on Bedrock.** WebFetch works.
- **Restarts keep the conversation** because session history lives on the `/data` volume. `restart.sh --fresh` starts clean.
- **Config changes need a redeploy**, since `gilfoyle.yaml` is baked into the image. A bad config fails at startup.
- **Missed crons don't catch up.** A job due while the bot is restarting is skipped.

## Browser

Each session can drive a headless Chromium through [Playwright MCP](https://github.com/microsoft/playwright-mcp), to check deployed pages, reproduce UI bugs, or test a dev server it started in a world. Playwright MCP says it is not a security boundary, so the bridge adds its own guardrails (`bridge/browser.ts`):

- **Egress guard.** All browser traffic goes through a proxy in the bridge that resolves each host once, refuses private, link-local and other non-public addresses (cloud metadata, the cluster or Docker network, the host machine), and connects to the address it checked, so DNS can't be swapped mid-request. The container's own localhost stays reachable for dev servers. WebRTC can't send UDP around the proxy. Refusals are logged as `egress_denied`.
- **No secrets in the browser.** Playwright MCP and Chromium start from an empty environment: no `GH_TOKEN`, Slack tokens or model keys.
- **Fewer tools.** The agent doesn't get Playwright's run-code tool (arbitrary JavaScript in the MCP process) or the file upload and drop tools (local files into a page). Pages can't register tools (WebMCP) or service workers.
- **No memory.** Every session gets a fresh in-memory profile, so no cookies or logins carry over. An idle browser closes after 10 minutes.
- **Rules.** `CLAUDE.md` tells the agent to treat pages as untrusted, never type secrets or internal data into them, and not to submit, sign up, log in or post unless an engineer asks.

Limits: the guard covers the browser only. The agent's shell and WebFetch could already reach the network before the browser was added. To close that too, block the metadata address and private ranges at the network layer (a Kubernetes NetworkPolicy, or IMDSv2 with a hop limit of 1). Chromium runs without its own sandbox, as Playwright does in containers, so the container is the boundary. Don't run it with host networking. The browser makes the image about 1.9 GB, and each session using it runs its own Chromium. `browser: false` turns it off.

## Develop

```bash
cd bridge && bun install && bun test && bunx tsc --noEmit
```

## License

[MIT](LICENSE)
