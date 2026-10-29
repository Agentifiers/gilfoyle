#!/bin/bash
# Release a world claimed by claim-world.sh. Its files stay until the next claim.
# Usage: release-world.sh <world-path>
set -euo pipefail
rmdir "${1:?usage: release-world.sh <world-path>}/.busy" 2>/dev/null && echo released || echo "not held"
