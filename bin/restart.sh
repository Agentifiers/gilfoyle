#!/bin/bash
# Restart the bot; the orchestrator brings the container back. The conversation
# carries over unless --fresh is passed.
set -euo pipefail
[ "${1:-}" = "--fresh" ] && touch "$GILFOYLE_DATA/fresh"
sleep 2
kill 1
