#!/bin/bash
# Container entrypoint: set up git and skills, then run the bridge, which runs
# the agent. The container exits when the bridge does, and the orchestrator
# restarts it.
#
# Required env: SLACK_BOT_TOKEN, SLACK_APP_TOKEN, GH_TOKEN, model credentials
# (an AWS role for Bedrock, or ANTHROPIC_API_KEY), plus whatever gilfoyle.yaml's
# `tools` reference.
set -euo pipefail

: "${GILFOYLE_DATA:?}" "${GH_TOKEN:?}"
APP=/opt/gilfoyle
WORK="$GILFOYLE_DATA/session"
export HOME="$GILFOYLE_DATA/home"
mkdir -p "$WORK/.claude" "$HOME" "$GILFOYLE_DATA/worlds"

rm -rf "$WORK/.claude/skills"
[ -d "$APP/skills" ] && cp -r "$APP/skills" "$WORK/.claude/skills"

git config --global credential.helper '!gh auth git-credential'
# Commit as the account GH_TOKEN belongs to, which also opens the PRs. A made-up
# <name>@users.noreply.github.com address credits whoever owns that GitHub login.
if [ -z "${GIT_AUTHOR_EMAIL:-}" ]; then
  if ! who=$(gh api user --jq '[.id, .login, (.name // .login)] | @tsv'); then
    echo "entrypoint: can't look up GH_TOKEN's GitHub user; set GIT_AUTHOR_NAME and GIT_AUTHOR_EMAIL (e.g. for a GitHub App token)" >&2
    exit 1
  fi
  IFS=$'\t' read -r gh_id gh_login gh_name <<<"$who"
  GIT_AUTHOR_EMAIL="$gh_id+$gh_login@users.noreply.github.com"
  GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-$gh_name}"
fi
git config --global user.name "${GIT_AUTHOR_NAME:?set GIT_AUTHOR_NAME with GIT_AUTHOR_EMAIL}"
git config --global user.email "$GIT_AUTHOR_EMAIL"
export GIT_TERMINAL_PROMPT=0

# Any lock on start is left over from a crash. claim-world.sh discards leftover changes.
rmdir "$GILFOYLE_DATA"/worlds/*/.busy 2>/dev/null || true

exec bun "$APP/bridge/server.ts"
