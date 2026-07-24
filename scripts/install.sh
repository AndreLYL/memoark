#!/bin/sh
# memkin one-command installer — Mac + Linux
# Usage: curl -fsSL https://raw.githubusercontent.com/AndreLYL/memkin/main/scripts/install.sh | sh
set -eu

STABLE_CONFIG="${MEMKIN_CONFIG:-$HOME/.memkin/memkin.yaml}"
MIN_NODE_MAJOR=18
PATH_MARKER_BEGIN="# >>> memkin npm global bin >>>"
PATH_MARKER_END="# <<< memkin npm global bin <<<"
MEMKIN_RUNNER="direct"
MEMKIN_RUNNER_RESOLVED=0
NPM_GLOBAL_BIN=""

# MEMKIN_INSTALL_DRYRUN=1 prints commands instead of running them (used by tests); the script may still write profile files during dryrun.
run() {
  if [ "${MEMKIN_INSTALL_DRYRUN:-0}" = "1" ]; then
    echo "DRYRUN: $*"
  else
    "$@"
  fi
}

log()  { printf '\033[36m[memkin]\033[0m %s\n' "$1"; }
fail() { printf '\033[31m[memkin] %s\033[0m\n' "$1" >&2; exit 1; }

path_contains() {
  case ":$PATH:" in
    *":$1:"*) return 0 ;;
    *) return 1 ;;
  esac
}

detect_npm_global_bin() {
  prefix="$(npm config get prefix 2>/dev/null || true)"
  case "$prefix" in
    "" | null | undefined) return 1 ;;
  esac
  printf '%s\n' "$prefix/bin"
}

add_profile_path_block() {
  profile="$1"
  [ -n "$profile" ] || return 0

  if [ ! -f "$profile" ]; then
    : >"$profile" 2>/dev/null || { log "Skipping $profile (not writable)."; return 0; }
  fi

  if grep -F "$PATH_MARKER_BEGIN" "$profile" >/dev/null 2>&1; then
    log "PATH helper already present in $profile"
    return 0
  fi

  {
    printf '\n%s\n' "$PATH_MARKER_BEGIN"
    # shellcheck disable=SC2016
    printf 'case ":$PATH:" in\n'
    printf '  *":%s:"*) ;;\n' "$NPM_GLOBAL_BIN"
    # shellcheck disable=SC2016
    printf '  *) export PATH="$PATH:%s" ;;\n' "$NPM_GLOBAL_BIN"
    printf 'esac\n'
    printf '%s\n' "$PATH_MARKER_END"
  } >>"$profile"
  PROFILE_PATH_UPDATED=1
  [ -n "$PROFILE_SOURCE_HINT" ] || PROFILE_SOURCE_HINT="$profile"
  log "Added npm global bin PATH to $profile"
}

persist_npm_global_bin_path() {
  PROFILE_PATH_UPDATED=0
  PROFILE_SOURCE_HINT=""
  os_name="$(uname -s 2>/dev/null || echo unknown)"
  case "$os_name" in
    Darwin)
      add_profile_path_block "$HOME/.zshrc"
      add_profile_path_block "$HOME/.bash_profile"
      ;;
    Linux)
      add_profile_path_block "$HOME/.profile"
      add_profile_path_block "$HOME/.bashrc"
      ;;
    *)
      add_profile_path_block "$HOME/.profile"
      ;;
  esac

  if [ "$PROFILE_PATH_UPDATED" = "1" ]; then
    if [ -n "$PROFILE_SOURCE_HINT" ]; then
      log "Updated shell profile PATH for future sessions. Restart your terminal or run: . \"$PROFILE_SOURCE_HINT\""
    else
      log "Updated shell profile PATH for future sessions. Restart your terminal."
    fi
  fi
}

configure_npm_global_bin_path() {
  NPM_GLOBAL_BIN="$(detect_npm_global_bin || true)"
  [ -n "$NPM_GLOBAL_BIN" ] || { log "Could not detect npm global bin path."; return 0; }

  if path_contains "$NPM_GLOBAL_BIN"; then
    log "npm global bin already in PATH: $NPM_GLOBAL_BIN"
    return 0
  fi

  export PATH="$PATH:$NPM_GLOBAL_BIN"
  log "Temporarily added npm global bin to PATH: $NPM_GLOBAL_BIN"
  persist_npm_global_bin_path
}

resolve_memkin_runner() {
  if [ "$MEMKIN_RUNNER_RESOLVED" = "1" ]; then
    return
  fi

  if command -v memkin >/dev/null 2>&1; then
    MEMKIN_RUNNER="direct"
    MEMKIN_RUNNER_RESOLVED=1
    log "Using memkin from PATH: $(command -v memkin)"
    return
  fi
  if [ -n "$NPM_GLOBAL_BIN" ] && [ -x "$NPM_GLOBAL_BIN/memkin" ]; then
    MEMKIN_RUNNER="npm_global_bin"
    MEMKIN_RUNNER_RESOLVED=1
    log "Using memkin from npm global bin: $NPM_GLOBAL_BIN/memkin"
    return
  fi
  MEMKIN_RUNNER="npm_exec"
  MEMKIN_RUNNER_RESOLVED=1
  log "memkin not on PATH yet; using npm exec fallback for installer commands."
}

run_memkin() {
  if [ "$MEMKIN_RUNNER" = "direct" ]; then
    run memkin "$@"
  elif [ "$MEMKIN_RUNNER" = "npm_global_bin" ]; then
    run "$NPM_GLOBAL_BIN/memkin" "$@"
  else
    run npm exec --yes memkin@latest -- "$@"
  fi
}

node_major() {
  command -v node >/dev/null 2>&1 || { echo 0; return; }
  node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

ensure_node() {
  if [ "$(node_major)" -ge "$MIN_NODE_MAJOR" ]; then
    log "Node $(node -v) OK"
    return
  fi
  log "Node >= $MIN_NODE_MAJOR not found — installing…"
  if command -v brew >/dev/null 2>&1; then
    run brew install node
  elif command -v apt-get >/dev/null 2>&1; then
    run sh -c 'curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && apt-get install -y nodejs'
  else
    fail "Could not auto-install Node. Please install Node >= $MIN_NODE_MAJOR from https://nodejs.org then re-run."
  fi
  [ "$(node_major)" -ge "$MIN_NODE_MAJOR" ] || fail "Node install did not produce a usable node >= $MIN_NODE_MAJOR."
}

ensure_memkin() {
  log "Installing memkin globally (npm i -g memkin@latest)…"
  if ! run npm install -g memkin@latest; then
    fail "Global install failed. If this is a permissions (EACCES) error, set an npm prefix you own (npm config set prefix ~/.npm-global) or re-run with sudo."
  fi
  configure_npm_global_bin_path
  resolve_memkin_runner
}

run_wizard_if_needed() {
  if [ -f "$STABLE_CONFIG" ]; then
    log "Existing config found at $STABLE_CONFIG — skipping setup wizard."
    return
  fi
  mkdir -p "$(dirname "$STABLE_CONFIG")"
  log "Launching setup wizard in your browser…"
  run_memkin init --web -c "$STABLE_CONFIG" &
  WIZARD_PID=$!
  log "Waiting for you to finish the wizard (fill your LLM API key and Save)…"
  i=0
  while [ ! -f "$STABLE_CONFIG" ]; do
    i=$((i + 1))
    [ "$i" -gt 600 ] && { kill "$WIZARD_PID" 2>/dev/null || true; fail "Timed out waiting for setup. Finish the wizard, then re-run this installer."; }
    sleep 1
  done
  log "Config saved. Stopping the wizard…"
  kill "$WIZARD_PID" 2>/dev/null || true
  wait "$WIZARD_PID" 2>/dev/null || true
}

start_service() {
  log "Starting the always-on background service + wiring your AI agents…"
  # --linger (Linux only): keep the systemd user service running after SSH
  # logout — otherwise the daemon (and managed Postgres) stops with the last
  # login session. Best-effort inside memkin; harmless on desktop Linux.
  LINGER_FLAG=""
  [ "$(uname -s)" = "Linux" ] && LINGER_FLAG="--linger"
  run_memkin up $LINGER_FLAG -c "$STABLE_CONFIG"
  log "Done. Manage it with:  memkin status  |  memkin down"
}

main() {
  ensure_node
  ensure_memkin
  run_wizard_if_needed
  start_service
  log "✅ memkin is installed and running as a background service."
}
main "$@"
