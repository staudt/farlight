#!/usr/bin/env bash
# Stop / SubagentStop: run `npm run check` (typecheck, lint, tests, build) when code changed,
# plus the headless smoke test when render, terrain or shader code changed.
# Exit 2 blocks the stop and feeds the failure back. Loop guard: after 3 consecutive
# failures the stop is allowed, with a warning, so an unfixable problem cannot trap a session.
input=$(cat)
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty')
[[ -z "$cwd" ]] && cwd=$PWD
root=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null) || exit 0
[[ -f "$root/package.json" ]] || exit 0
cd "$root" || exit 0
state=.claude/hooks/.state
mkdir -p "$state"
ok_stamp=$state/last-check-ok
smoke_stamp=$state/last-smoke-ok
fails_file=$state/consecutive-failures

changed() { # $1 = stamp file, rest = paths
  local stamp=$1; shift
  [[ ! -f "$stamp" ]] && return 0
  [[ -n $(find "$@" -newer "$stamp" -type f \( -name '*.ts' -o -name '*.glsl' -o -name '*.mjs' -o -name '*.json' -o -name '*.html' \) -not -path '*/node_modules/*' 2>/dev/null | head -1) ]]
}

fail() {
  local n=$(( $(cat "$fails_file" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "$fails_file"
  if (( n > 3 )); then
    echo 0 > "$fails_file"
    printf '{"systemMessage": "Stop hook: checks still failing after 3 attempts, letting the stop through. Run npm run check."}\n'
    exit 0
  fi
  printf '%s\n' "$1" >&2
  exit 2
}

if changed "$ok_stamp" src tests scripts index.html package.json; then
  out=$(npm run --silent check 2>&1)
  if [[ $? -ne 0 ]]; then
    fail "npm run check failed (attempt $(( $(cat "$fails_file" 2>/dev/null || echo 0) + 1 ))/3). Fix before finishing:
$(printf '%s' "$out" | grep -v '^\s*$' | tail -40)"
  fi
  touch "$ok_stamp"
fi

if changed "$smoke_stamp" src/render src/terrain src/main.ts src/scenarios.ts; then
  out=$(timeout 240 node scripts/smoke.mjs --no-build 2>&1)
  if [[ $? -ne 0 ]]; then
    fail "Smoke test failed. Screenshots in artifacts/smoke/:
$(printf '%s' "$out" | tail -30)"
  fi
  touch "$smoke_stamp"
fi
echo 0 > "$fails_file"
exit 0
