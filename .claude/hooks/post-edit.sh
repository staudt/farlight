#!/usr/bin/env bash
# PostToolUse (Edit|Write|MultiEdit): typecheck the project and lint the edited file.
# Exit 2 feeds the errors back to the agent that made the edit.
input=$(cat)
f=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_response.filePath // empty')
[[ -z "$f" ]] && exit 0
[[ "$f" =~ \.(ts|mjs)$ ]] || exit 0
[[ "$f" == */node_modules/* ]] && exit 0
root=$(git -C "$(dirname "$f")" rev-parse --show-toplevel 2>/dev/null) || exit 0
[[ -f "$root/package.json" ]] || exit 0
cd "$root" || exit 0
mkdir -p .claude/hooks/.state
out=""
if [[ "$f" =~ \.ts$ ]]; then
  tsc_out=$(npx tsc --noEmit --incremental --tsBuildInfoFile .claude/hooks/.state/tsc.tsbuildinfo -p . 2>&1)
  [[ $? -ne 0 ]] && out+="TypeScript errors:"$'\n'"$(printf '%s' "$tsc_out" | head -25)"$'\n'
fi
case "$f" in
  "$root"/src/*|"$root"/tests/*)
    lint_out=$(npx eslint --max-warnings=0 "$f" 2>&1)
    [[ $? -ne 0 ]] && out+="ESLint ($f):"$'\n'"$(printf '%s' "$lint_out" | head -25)"$'\n'
    ;;
esac
if [[ -n "$out" ]]; then
  printf '%s' "$out" >&2
  exit 2
fi
exit 0
