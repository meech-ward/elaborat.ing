#!/bin/sh
# Try the assistant on your ChatGPT plan from a fresh clone, in one command:
#
#   bun run try:chatgpt
#
# Installs the packages, writes .env.local from .env.example with the hosted
# project's public values when there is none (public values only: Vite ships
# them to every browser), starts the dev server with VITE_CHATGPT_PLAN=1 on
# 127.0.0.1:5173 (the exact address ChatGPT sends you back to), waits until it
# answers and opens it in your browser. Ctrl+C stops it.
set -eu
cd "$(dirname "$0")/.."

URL=http://127.0.0.1:5173
HOSTED_URL=https://njxjkmtvconypwujbiur.supabase.co
HOSTED_KEY=sb_publishable_2xMwCVf3iXRdIXDYoWeFDg_OPys7AgH

if ! command -v bun >/dev/null 2>&1; then
  echo "Bun is needed: https://bun.sh (curl -fsSL https://bun.sh/install | bash)" >&2
  exit 1
fi
echo "Bun $(bun --version)"

bun install --frozen-lockfile

if [ ! -f .env.local ]; then
  sed -e "s|^VITE_SUPABASE_URL=.*|VITE_SUPABASE_URL=$HOSTED_URL|" \
    -e "s|^VITE_SUPABASE_PUBLISHABLE_KEY=.*|VITE_SUPABASE_PUBLISHABLE_KEY=$HOSTED_KEY|" \
    .env.example >.env.local
  echo "Wrote .env.local with the hosted project's public values. Edit it to use your own project."
fi

# Opens the browser once the server answers; gives up when the server is gone
# or after a minute. Without open or xdg-open (a container, a remote shell),
# it says where to go instead.
(
  tries=0
  until bun -e "fetch('$URL').then(() => process.exit(0), () => process.exit(1))" 2>/dev/null; do
    kill -0 "$$" 2>/dev/null || exit 0
    tries=$((tries + 1))
    [ "$tries" -lt 60 ] || exit 0
    sleep 1
  done
  if [ "$(uname -s)" = Darwin ]; then open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
  else echo "Open $URL in your browser."
  fi
) &

# The dev server takes over this process, so Ctrl+C stops it directly.
export VITE_CHATGPT_PLAN=1
exec bun run dev --port 5173 --strictPort
