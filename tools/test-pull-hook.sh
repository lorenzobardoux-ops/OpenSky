#!/bin/bash
# Test for `opensky pull-hook on|off` + tools/after-pull.sh, and that `opensky update` leaves an own branch alone,
# against a throwaway git "GitHub" (a local bare repo). OPENSKY_DRY_RUN=1: install.sh / restart are only reported.
REPO="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok() { if eval "$2"; then pass=$((pass+1)); echo "PASS  $1"; else fail=$((fail+1)); echo "FAIL  $1"; fi; }
g() { git -c user.name=t -c user.email=t@t -c init.defaultBranch=main "$@"; }
export OPENSKY_DRY_RUN=1 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

mkdir -p "$T/src/tools" "$T/src/modules/MMM-OpenSky-A" "$T/src/config"
cp "$REPO/tools/opensky" "$REPO/tools/after-pull.sh" "$T/src/tools/"
echo 1 > "$T/src/modules/MMM-OpenSky-A/a.js"; echo '#!/bin/bash' > "$T/src/install.sh"
printf 'config/*\n!config/.keep\n' > "$T/src/.gitignore"; touch "$T/src/config/.keep"
(cd "$T/src" && g init -q && g add -A && g commit -qm v1 && g tag v1.0.0 && g checkout -qb mine)
g clone -q --bare "$T/src" "$T/origin.git"
g clone -q -b mine "$T/origin.git" "$T/pi"
OS="$T/pi/tools/opensky"
change() { (cd "$T/src" && mkdir -p "$(dirname "$1")" && echo "$2" >> "$1" && g add -A && g commit -qm "$1" && g push -q "$T/origin.git" mine); }
pull() { (cd "$T/pi" && git pull -q 2>&1); }

ok "1 off by default" '[ "$("$OS" pull-hook)" = Off ]'
out=$("$OS" pull-hook on); ok "2 pull-hook on → a post-merge hook" '[ -x "$T/pi/.git/hooks/post-merge" ] && [ "$("$OS" pull-hook)" != Off ]'
change modules/MMM-OpenSky-A/a.js 2; out=$(pull)
ok "3 a module file changed → restart, no install.sh" '[[ "$out" == *"would run: "*"/tools/opensky restart"* ]] && [[ "$out" != *install.sh* ]]'
change modules/MMM-OpenSky-B/b.js 1; out=$(pull)
ok "4 a new module → install.sh, then restart" '[[ "$out" == *"would run: ./install.sh --yes"* ]] && [[ "$out" == *"opensky restart"* ]]'
change install.sh "# new"; out=$(pull)
ok "5 install.sh changed → install.sh" '[[ "$out" == *"would run: ./install.sh --yes"* ]]'
out=$(pull)
ok "6 nothing new → nothing runs" '[[ "$out" != *"would run"* ]]'
out=$("$OS" update 2>&1); st=$?
ok "7 opensky update on an own branch → refuses, says git pull" '[ $st = 1 ] && [[ "$out" == *"git pull"* ]] && [ "$(cd "$T/pi" && git symbolic-ref --short HEAD)" = mine ]'
"$OS" pull-hook off >/dev/null
ok "8 pull-hook off → hook gone" '[ ! -e "$T/pi/.git/hooks/post-merge" ] && [ "$("$OS" pull-hook)" = Off ]'
echo '#!/bin/sh' > "$T/pi/.git/hooks/post-merge"
out=$("$OS" pull-hook on 2>&1); st=$?
ok "9 someone else's post-merge hook → not replaced" '[ $st = 1 ] && [ "$(cat "$T/pi/.git/hooks/post-merge")" = "#!/bin/sh" ]'
echo "SUMMARY pass=$pass fail=$fail"
[ $fail = 0 ]
