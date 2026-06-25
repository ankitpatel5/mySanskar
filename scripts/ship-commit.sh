#!/usr/bin/env bash
# Auto-commit any pending working-tree changes before a prod ship, so git history
# never diverges from what gets deployed to production.
#
# Vercel deploys the working tree (committed + uncommitted), but `git push` only
# moves already-committed work. Without this step, shipping uncommitted changes
# updates prod while leaving git frozen. Run on the `staging` branch.
#
# Message: defaults to a timestamp. Override with `npm run ship --m="your message"`
# (npm exposes that as $npm_config_m).

set -euo pipefail

# Nothing to commit — exit cleanly so the rest of `ship` proceeds.
if git diff --quiet && git diff --cached --quiet && [ -z "$(git status --porcelain --untracked-files=normal)" ]; then
  echo "→ ship-commit: working tree clean, nothing to commit"
  exit 0
fi

MSG="${npm_config_m:-}"
if [ -z "$MSG" ]; then
  MSG="deploy: $(date '+%Y-%m-%d %H:%M:%S')"
fi

echo "→ ship-commit: committing pending changes — \"$MSG\""
git add -A
git commit -m "$MSG"
