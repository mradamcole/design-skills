#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"
ROOT_DIR_WIN="$(cygpath -w "$ROOT_DIR" 2>/dev/null || echo "$ROOT_DIR")"

PORT="${APP_PORT:-3001}"
PID_FILE=".next/dev-server.pid"
LOG_FILE=".next/dev-server.log"

usage() {
  echo "Usage: ./server.sh <status|start|stop|reset>"
}

is_pid_running() {
  local pid="${1:-}"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

read_pid() {
  if [[ -f "$PID_FILE" ]]; then
    tr -d '[:space:]' < "$PID_FILE"
  fi
}

is_port_in_use() {
  node -e "
    const net = require('net');
    const port = Number(process.argv[1]);
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(1200);
    socket.on('connect', () => { socket.destroy(); process.exit(0); });
    socket.on('timeout', () => { socket.destroy(); process.exit(1); });
    socket.on('error', () => process.exit(1));
  " "$PORT" >/dev/null 2>&1
}

port_pid() {
  node -e "
    const { execSync } = require('child_process');
    const port = String(process.argv[1]);
    const output = execSync('netstat -ano -p tcp', { encoding: 'utf8' });
    const lines = output.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.includes('LISTENING')) continue;
      if (!trimmed.includes(':' + port)) continue;
      const parts = trimmed.split(/\s+/);
      const localAddress = parts[1] || '';
      const pid = parts[parts.length - 1] || '';
      if (!localAddress.endsWith(':' + port)) continue;
      if (/^\d+$/.test(pid)) {
        process.stdout.write(pid);
        process.exit(0);
      }
    }
    process.exit(1);
  " "$PORT" 2>/dev/null || true
}

process_command_line() {
  local pid="${1:-}"
  if [[ -z "$pid" ]]; then
    return 0
  fi
  powershell.exe -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \"ProcessId=$pid\").CommandLine" 2>/dev/null | tr -d '\r' || true
}

is_our_app_process() {
  local pid="${1:-}"
  local cmdline
  cmdline="$(process_command_line "$pid")"
  local cmdline_lower
  cmdline_lower="$(printf "%s" "$cmdline" | tr '[:upper:]' '[:lower:]')"
  local root_lower
  root_lower="$(printf "%s" "$ROOT_DIR_WIN" | tr '[:upper:]' '[:lower:]')"
  local root_posix_lower
  root_posix_lower="$(printf "%s" "$ROOT_DIR" | tr '[:upper:]' '[:lower:]')"

  if [[ "$cmdline_lower" == *"next dev"* || "$cmdline_lower" == *"npm run dev"* ]]; then
    [[ "$cmdline_lower" == *"$root_lower"* || "$cmdline_lower" == *"$root_posix_lower"* ]] && return 0
  fi

  if [[ "$cmdline_lower" == *"next\\dist\\server\\lib\\start-server.js"* ]]; then
    [[ "$cmdline_lower" == *"$root_lower"* || "$cmdline_lower" == *"$root_posix_lower"* ]] && return 0
  fi

  return 1
}

kill_process_tree() {
  local pid="${1:-}"
  [[ -z "$pid" ]] && return 0
  taskkill //PID "$pid" //T //F >/dev/null 2>&1 || true
}

print_status() {
  local pid
  pid="$(read_pid || true)"
  local running="no"
  local port_open="no"
  local in_use_pid=""

  if is_port_in_use; then
    port_open="yes"
    in_use_pid="$(port_pid)"
  fi

  if [[ -n "$pid" ]] && is_pid_running "$pid"; then
    running="yes"
  elif [[ -n "$pid" ]]; then
    rm -f "$PID_FILE"
  fi

  echo "Server status"
  echo "  running: $running"
  echo "  port: $PORT"
  echo "  port_open: $port_open"
  if [[ -n "$in_use_pid" ]]; then
    echo "  port_pid: $in_use_pid"
  fi
  echo "  pid_file: $PID_FILE"
  if [[ -n "$pid" && "$running" == "yes" ]]; then
    echo "  pid: $pid"
  fi
  echo "  log_file: $LOG_FILE"
  echo "  url: http://localhost:$PORT"
}

start_server() {
  local pid
  pid="$(read_pid || true)"
  if [[ -n "$pid" ]] && is_pid_running "$pid"; then
    echo "Server is already running (pid $pid) on http://localhost:$PORT"
    return 0
  fi

  if is_port_in_use; then
    local occupied_pid
    occupied_pid="$(port_pid)"
    if [[ -n "$occupied_pid" ]] && is_our_app_process "$occupied_pid"; then
      echo "Port $PORT is in use by this app (pid $occupied_pid). Stopping it first."
      kill_process_tree "$occupied_pid"
      sleep 1
    else
      echo "Port $PORT is already in use by pid ${occupied_pid:-unknown}."
      echo "It does not look like this app, so it will not be killed automatically."
      return 1
    fi
  fi

  if is_port_in_use; then
    echo "Port $PORT is still in use after stop attempt. Aborting start."
    return 1
  fi

  mkdir -p .next
  nohup npm run dev -- --port "$PORT" >"$LOG_FILE" 2>&1 &
  pid=$!
  echo "$pid" > "$PID_FILE"

  sleep 1
  if is_pid_running "$pid"; then
    echo "Started dev server (pid $pid)"
    echo "URL: http://localhost:$PORT"
    echo "Logs: $LOG_FILE"
  else
    rm -f "$PID_FILE"
    echo "Failed to start server. Check logs: $LOG_FILE"
    return 1
  fi
}

stop_server() {
  local pid
  pid="$(read_pid || true)"
  if [[ -z "$pid" ]]; then
    echo "Server is not running (no pid file)."
    return 0
  fi

  if ! is_pid_running "$pid"; then
    rm -f "$PID_FILE"
    echo "Removed stale pid file."
    return 0
  fi

  kill "$pid" 2>/dev/null || true
  for _ in {1..20}; do
    if ! is_pid_running "$pid"; then
      rm -f "$PID_FILE"
      echo "Stopped server (pid $pid)."
      return 0
    fi
    sleep 0.2
  done

  kill -9 "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  echo "Force-stopped server (pid $pid)."
}

reset_server() {
  stop_server
  start_server
}

command="${1:-status}"
case "$command" in
  status) print_status ;;
  start) start_server ;;
  stop) stop_server ;;
  reset) reset_server ;;
  *)
    usage
    exit 1
    ;;
esac
