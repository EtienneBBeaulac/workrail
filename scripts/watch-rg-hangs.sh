#!/bin/bash
# watch-rg-hangs.sh
#
# Monitors for rg processes whose cwd is inside ~/.workrail/worktrees/ and captures
# diagnostics when they run suspiciously long.
#
# Usage (in a separate terminal):
#   ./scripts/watch-rg-hangs.sh
#
# Requires: lsof, sample, opensnoop (all available on macOS without sudo)

HANG_THRESHOLD_MS=2000
OUTPUT_DIR="$HOME/.workrail/dev"
mkdir -p "$OUTPUT_DIR"

echo "Watching for rg processes in worktrees (threshold: ${HANG_THRESHOLD_MS}ms)..."
echo "Output dir: $OUTPUT_DIR"
echo "Press Ctrl-C to stop."
echo ""

declare -A REPORTED_PIDS

capture_diagnostics() {
  local PID=$1
  local ELAPSED_AT_CAPTURE=$2
  local TIMESTAMP
  TIMESTAMP=$(date +%Y%m%d-%H%M%S)
  local OUT="$OUTPUT_DIR/rg-hang-$TIMESTAMP.txt"
  REPORTED_PIDS[$PID]=1

  echo ""
  echo "=== SLOW rg DETECTED: PID $PID (${ELAPSED_AT_CAPTURE}ms and counting) ==="
  echo "Capturing to: $OUT"

  {
    echo "rg hang diagnostic -- $(date)"
    echo "PID: $PID  elapsed_at_capture: ${ELAPSED_AT_CAPTURE}ms"
    echo ""

    echo "=== COMMAND LINE ==="
    ps -p "$PID" -o pid,etime,command 2>/dev/null
    echo ""

    echo "=== WORKING DIRECTORY ==="
    lsof -p "$PID" 2>/dev/null | grep cwd
    echo ""

    echo "=== ALL OPEN FILES (lsof) ==="
    lsof -p "$PID" 2>/dev/null
    echo ""

    echo "=== CALL STACK (sample 5s) ==="
    # sample shows which syscall the process is blocked in
    sample "$PID" 5 2>/dev/null
    echo ""

    echo "=== OPEN FILES AFTER SAMPLE ==="
    lsof -p "$PID" 2>/dev/null
    echo ""

  } | tee "$OUT"

  # opensnoop traces open() calls in real time -- shows the next file rg tries to open
  echo "=== OPENSNOOP (15s) ===" >> "$OUT"
  echo "(tracing open() calls for PID $PID...)"
  timeout 15 opensnoop -p "$PID" 2>/dev/null | tee -a "$OUT" &
  local SNOOP_PID=$!

  # Poll until rg exits, printing elapsed every 5s
  local START_MS
  START_MS=$(python3 -c "import time; print(int(time.time()*1000))")
  while kill -0 "$PID" 2>/dev/null; do
    sleep 1
    local NOW_MS
    NOW_MS=$(python3 -c "import time; print(int(time.time()*1000))")
    local TOTAL=$(( NOW_MS - START_MS + ELAPSED_AT_CAPTURE ))
    echo "  still running... ${TOTAL}ms total"
  done

  local FINAL_MS
  FINAL_MS=$(( $(python3 -c "import time; print(int(time.time()*1000))") - START_MS + ELAPSED_AT_CAPTURE ))
  echo "" >> "$OUT"
  echo "=== FINAL: PID $PID exited after ${FINAL_MS}ms total ===" | tee -a "$OUT"
  kill $SNOOP_PID 2>/dev/null
  echo "Full diagnostics saved: $OUT"
  echo ""
}

while true; do
  # Find all rg processes
  while IFS= read -r RG_PID; do
    [[ -z "$RG_PID" ]] && continue
    [[ -n "${REPORTED_PIDS[$RG_PID]}" ]] && continue

    # Check if its cwd is inside a worktree
    CWD=$(lsof -p "$RG_PID" 2>/dev/null | awk '/cwd/ {print $NF}')
    [[ "$CWD" != *"/.workrail/worktrees/"* ]] && continue

    # Track start time (python for portable milliseconds on macOS)
    local_start=$(python3 -c "import time; print(int(time.time()*1000))")

    # Wait to see if it finishes quickly
    while kill -0 "$RG_PID" 2>/dev/null; do
      sleep 0.05
      local_elapsed=$(( $(python3 -c "import time; print(int(time.time()*1000))") - local_start ))
      if [ "$local_elapsed" -ge "$HANG_THRESHOLD_MS" ]; then
        # Still running after threshold -- capture diagnostics
        if [[ -z "${REPORTED_PIDS[$RG_PID]}" ]]; then
          capture_diagnostics "$RG_PID" "$local_elapsed"
        fi
        break
      fi
    done

  done < <(pgrep rg 2>/dev/null)

  sleep 0.2
done
