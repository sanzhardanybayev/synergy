#!/usr/bin/env bash
# Synergy freshness guard. Fails open: any error => no output, exit 0.
set -u

plugins="${CLAUDE_PLUGINS_DIR:-$HOME/.claude/plugins}"
cache="$plugins/cache/synergy/synergy"
root="${CLAUDE_PLUGIN_ROOT:-}"

mine="$(basename "$root" 2>/dev/null)"
[ -d "$cache" ] || exit 0
[ -n "$mine" ] || exit 0

newest="$(ls "$cache" 2>/dev/null | sort -V | tail -1)"
[ -n "$newest" ] || exit 0

if [ "$newest" != "$mine" ] &&
  [ "$(printf '%s\n%s\n' "$mine" "$newest" | sort -V | tail -1)" = "$newest" ]; then
  printf '⚠ synergy: this session loaded v%s, but v%s is installed. Restart Claude Code to load the latest skills/templates.\n' "$mine" "$newest"
fi

# Best-effort upstream nudge: never blocks, 3s cap, silent on any failure.
if [ -z "${SYNERGY_SKIP_UPSTREAM:-}" ] && command -v git >/dev/null 2>&1; then
  upstream="$(timeout 3 git ls-remote --tags https://github.com/sanzhardanybayev/synergy 2>/dev/null |
    sed -n 's#.*refs/tags/v\([0-9.]*\)$#\1#p' | sort -V | tail -1)"
  if [ -n "$upstream" ] && [ "$upstream" != "$newest" ] &&
    [ "$(printf '%s\n%s\n' "$newest" "$upstream" | sort -V | tail -1)" = "$upstream" ]; then
    printf 'ℹ synergy: v%s is published upstream — run /plugin update to fetch it.\n' "$upstream"
  fi
fi
exit 0
