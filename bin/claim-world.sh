#!/bin/bash
# Claim a free world for one task: lock it, put every team repo on a fresh
# branch from origin/main, run each repo's setup, print the world path.
# Repos are cloned on first use.
#
# Usage: claim-world.sh <branch-name>
set -euo pipefail

branch="${1:?usage: claim-world.sh <branch-name>}"
if ! [[ "$branch" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]]; then
  echo "claim-world: invalid branch name: $branch" >&2
  exit 1
fi

config=$(bun -e 'console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(process.argv[1]).text())))' "${GILFOYLE_CONFIG:-/opt/gilfoyle/gilfoyle.yaml}")
org=$(jq -r .github.org <<<"$config")
count=$(jq -r '.worlds // 3' <<<"$config")

world=""
for i in $(seq 1 "$count"); do
  candidate="$GILFOYLE_DATA/worlds/$i"
  mkdir -p "$candidate"
  if mkdir "$candidate/.busy" 2>/dev/null; then world="$candidate"; break; fi
done
if [ -z "$world" ]; then
  echo "claim-world: all $count worlds are busy" >&2
  exit 2
fi
trap 'rmdir "$world/.busy" 2>/dev/null || true' EXIT

jq -c '.github.repos[]' <<<"$config" | while read -r repo; do
  name=$(jq -r .name <<<"$repo")
  setup=$(jq -r '.setup // empty' <<<"$repo")
  dir="$world/$name"
  [ -d "$dir/.git" ] || gh repo clone "$org/$name" "$dir" -- --quiet
  git -C "$dir" fetch origin --quiet
  git -C "$dir" checkout -f -B "$branch" origin/main --quiet
  git -C "$dir" clean -fdq
  if [ -n "$setup" ]; then
    (cd "$dir" && bash -c "$setup") || { echo "claim-world: setup failed in $name" >&2; exit 1; }
  fi
done

trap - EXIT
echo "$world"
