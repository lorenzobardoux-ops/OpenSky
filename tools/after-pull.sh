#!/bin/bash
# Runs by itself after `git pull` once `opensky pull-hook on` is set (git's post-merge hook calls it).
# For a Pi that follows its own branch (e.g. a fork): pull → OpenSky restarts with the new files.
# It runs ./install.sh --yes first only when the pull changed something install.sh sets up (the runtime, the
# services, a new module, a community module or patch); for everything else a restart is enough.
#   tools/after-pull.sh [OLD NEW]   (default: ORIG_HEAD HEAD — what the pull just brought)
# OPENSKY_DRY_RUN=1 (tests): says what it would do, runs nothing.
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1
OLD="${1:-ORIG_HEAD}"; NEW="${2:-HEAD}"
run() { if [ "${OPENSKY_DRY_RUN:-}" = 1 ]; then echo "(dry run) would run: $*"; else "$@"; fi; }

git rev-parse -q --verify "$OLD^{commit}" >/dev/null || { echo "OpenSky: no earlier version to compare with — restarting."; OLD="$NEW"; }
changed=$(git diff --name-only "$OLD" "$NEW")
[ -n "$changed" ] || [ "$OLD" = "$NEW" ] || { echo "OpenSky: nothing changed."; exit 0; }

needs_install=0
if grep -qE '^(install\.sh|tools/link-mm\.sh|tools/community-modules\.txt|tools/opensky-start|tools/opensky|patches/|services/)' <<<"$changed"; then
  needs_install=1
fi
# a module folder that's new in this pull has to be linked into MagicMirror (install.sh does that)
for m in $(grep -oE '^modules/MMM-OpenSky-[^/]+' <<<"$changed" | sort -u); do
  git cat-file -e "$OLD:$m" 2>/dev/null || needs_install=1
done

echo "OpenSky: new version $(git describe --tags --always "$NEW") pulled."
if [ $needs_install = 1 ]; then
  echo "OpenSky: setting up what changed (./install.sh --yes)…"
  run ./install.sh --yes || { echo "OpenSky: install.sh failed — see the messages above, then: opensky logs"; exit 1; }
fi
echo "OpenSky: restarting…"
run "$REPO/tools/opensky" restart && echo "OpenSky: restarted ✓  (if something looks wrong: opensky logs)"
