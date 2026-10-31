#!/bin/bash
# Validates that PR tests actually guard the changes they claim to guard.
# Usage: scripts/revert-checks.sh <pr-body-file> <base-ref>
#
# Each revert-check line in the PR body has the format:
#   revert-check: <test-file-or-name> guards <source-file>:<line-range>
#   revert-check: <test-file-or-name> guards <source-file>
#
# For each check, the script:
# 1. Restores the source lines to the base branch version
# 2. Runs only the named test
# 3. Expects the test to FAIL (proving it guards the change)
#
# Exit codes:
#   0 - All revert checks passed (tests failed when code reverted)
#   1 - A revert check failed (test still passed when code reverted)
#   2 - Malformed input or missing files
#   3 - Internal error

# Don't use set -e as we need to handle errors explicitly
set -uo pipefail

# Color output (disabled if not a terminal)
if [[ -t 1 ]]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  NC='\033[0m'
else
  RED=''
  GREEN=''
  YELLOW=''
  NC=''
fi

log_error() { echo -e "${RED}ERROR: $*${NC}" >&2; }
log_warn() { echo -e "${YELLOW}WARN: $*${NC}" >&2; }
log_ok() { echo -e "${GREEN}$*${NC}"; }
log_info() { echo "$*"; }

# Bounded run time (seconds)
TIMEOUT_PER_CHECK="${TIMEOUT_PER_CHECK:-120}"

usage() {
  echo "Usage: $0 <pr-body-file> <base-ref>"
  echo
  echo "Validates that PR tests guard their claimed changes."
  echo "Each 'revert-check:' line in the PR body is verified."
  exit 2
}

# Parse command line
[[ $# -ge 2 ]] || usage
PR_BODY_FILE="$1"
BASE_REF="$2"

[[ -f "$PR_BODY_FILE" ]] || { log_error "PR body file not found: $PR_BODY_FILE"; exit 2; }

# Verify we're in a git repository
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { log_error "Not in a git repository"; exit 3; }

# Verify base ref exists
git rev-parse --verify "$BASE_REF" >/dev/null 2>&1 || { log_error "Base ref not found: $BASE_REF"; exit 2; }

# Extract revert-check lines from PR body
# Format: revert-check: <test> guards <source>[:range]
CHECKS=()
MALFORMED=()
while IFS= read -r line; do
  # Skip empty lines and lines that don't match
  [[ "$line" =~ ^revert-check:[[:space:]]* ]] || continue

  # Extract the content after "revert-check:"
  content="${line#revert-check:}"
  content="${content#"${content%%[![:space:]]*}"}"  # trim leading whitespace

  # Parse: <test> guards <source>[:range]
  if [[ "$content" =~ ^([^[:space:]]+)[[:space:]]+guards[[:space:]]+([^[:space:]]+)$ ]]; then
    test_spec="${BASH_REMATCH[1]}"
    source_spec="${BASH_REMATCH[2]}"
    CHECKS+=("$test_spec|$source_spec")
  else
    MALFORMED+=("$line")
  fi
done < "$PR_BODY_FILE"

# Report malformed lines
if [[ ${#MALFORMED[@]} -gt 0 ]]; then
  log_error "Malformed revert-check lines:"
  for m in "${MALFORMED[@]}"; do
    log_error "  $m"
  done
  exit 2
fi

# If no checks, nothing to do
if [[ ${#CHECKS[@]} -eq 0 ]]; then
  log_info "No revert-check lines found in PR body."
  exit 0
fi

log_info "Found ${#CHECKS[@]} revert-check(s) to verify"
log_info ""

# Track results
PASSED=0
FAILED=0
ERRORS=0

# Save current HEAD for restoration
ORIGINAL_HEAD=$(git rev-parse HEAD)

# Cleanup function
cleanup() {
  # Restore original state
  git checkout --quiet "$ORIGINAL_HEAD" -- . 2>/dev/null || true
  git clean -fd --quiet 2>/dev/null || true
}
trap cleanup EXIT

# Process each check
for check in "${CHECKS[@]}"; do
  IFS='|' read -r test_spec source_spec <<< "$check"

  log_info "=== Checking: $test_spec guards $source_spec ==="

  # Parse source spec (file:range or just file)
  if [[ "$source_spec" =~ ^([^:]+):(.+)$ ]]; then
    source_file="${BASH_REMATCH[1]}"
    line_range="${BASH_REMATCH[2]}"
  else
    source_file="$source_spec"
    line_range=""
  fi

  # Validate source file exists in current tree
  if [[ ! -f "$source_file" ]]; then
    log_error "Source file not found: $source_file"
    ERRORS=$((ERRORS + 1))
    continue
  fi

  # Validate test spec (file path or test name pattern)
  # For vitest, test spec can be a file path or a pattern
  test_file=""
  if [[ "$test_spec" == *.test.ts ]] || [[ "$test_spec" == *.spec.ts ]]; then
    test_file="$test_spec"
    if [[ ! -f "$test_file" ]]; then
      log_error "Test file not found: $test_file"
      ERRORS=$((ERRORS + 1))
      continue
    fi
  fi

  # Revert the source file (or specific lines) to base version
  if [[ -z "$line_range" ]]; then
    # Revert entire file to base
    if git show "$BASE_REF:$source_file" > "$source_file" 2>/dev/null; then
      log_info "  Reverted entire file to base"
    else
      # File may not exist in base - that's OK for new files
      # Treat as: remove the file entirely
      rm -f "$source_file"
      log_info "  (file did not exist in base, removed)"
    fi
  else
    # Revert specific line range
    log_info "  Reverting lines $line_range to base"

    # Get the base version of the file
    base_content=""
    if git show "$BASE_REF:$source_file" > /dev/null 2>&1; then
      base_content=$(git show "$BASE_REF:$source_file" 2>/dev/null)
    fi
    current_content=$(cat "$source_file")

    if [[ -z "$base_content" ]]; then
      # File didn't exist in base, can't do line-level revert
      log_error "Cannot revert lines - file did not exist in base: $source_file"
      ERRORS=$((ERRORS + 1))
      continue
    fi

    # Save base and current to temp files for processing
    tmp_base=$(mktemp)
    tmp_current=$(mktemp)
    echo "$base_content" > "$tmp_base"
    echo "$current_content" > "$tmp_current"

    # Process the line range
    if [[ "$line_range" =~ ^([0-9]+)-([0-9]+)$ ]]; then
      # Range: N-M
      start_line="${BASH_REMATCH[1]}"
      end_line="${BASH_REMATCH[2]}"

      # Extract lines before, the base lines, and lines after
      head -n "$((start_line - 1))" "$tmp_current" > "${tmp_current}.new"
      sed -n "${start_line},${end_line}p" "$tmp_base" >> "${tmp_current}.new"
      tail -n "+$((end_line + 1))" "$tmp_current" >> "${tmp_current}.new"
      mv "${tmp_current}.new" "$source_file"
    elif [[ "$line_range" =~ ^[0-9]+$ ]]; then
      # Single line: N
      line_num="$line_range"
      head -n "$((line_num - 1))" "$tmp_current" > "${tmp_current}.new"
      sed -n "${line_num}p" "$tmp_base" >> "${tmp_current}.new"
      tail -n "+$((line_num + 1))" "$tmp_current" >> "${tmp_current}.new"
      mv "${tmp_current}.new" "$source_file"
    else
      log_error "Unsupported line range format: $line_range (use N, N-M)"
      rm -f "$tmp_base" "$tmp_current"
      ERRORS=$((ERRORS + 1))
      continue
    fi

    rm -f "$tmp_base" "$tmp_current"
  fi

  # Run the test (expecting it to FAIL)
  log_info "  Running test: $test_spec (expecting FAIL)"

  # Build the npm test command
  # For vitest, we can pass a filter pattern
  if [[ -n "$test_file" ]]; then
    test_cmd="npm test -- --reporter=basic $test_file"
  else
    # Use as a pattern/filter
    test_cmd="npm test -- --reporter=basic -t '$test_spec'"
  fi

  # Run with timeout (use 'timeout' command if available, else just run)
  test_rc=0
  if command -v timeout >/dev/null 2>&1; then
    timeout "$TIMEOUT_PER_CHECK" bash -c "$test_cmd" >/dev/null 2>&1
    test_rc=$?
  else
    bash -c "$test_cmd" >/dev/null 2>&1
    test_rc=$?
  fi

  # Check result: we WANT the test to fail (rc != 0)
  if [[ $test_rc -eq 0 ]]; then
    log_error "  REVERT-CHECK FAILED: Test still passes when guarded code is reverted!"
    log_error "  This test does not actually guard the change it claims to guard."
    FAILED=$((FAILED + 1))
  elif [[ $test_rc -eq 124 ]]; then
    log_error "  Test timed out after ${TIMEOUT_PER_CHECK}s"
    ERRORS=$((ERRORS + 1))
  else
    log_ok "  PASSED: Test fails when guarded code is reverted (exit code: $test_rc)"
    PASSED=$((PASSED + 1))
  fi

  # Restore the source file for next check
  git checkout --quiet "$ORIGINAL_HEAD" -- "$source_file" 2>/dev/null || true

  log_info ""
done

# Summary
log_info "=== Summary ==="
log_info "  Passed: $PASSED"
log_info "  Failed: $FAILED"
log_info "  Errors: $ERRORS"

# Exit code
if [[ $FAILED -gt 0 ]]; then
  log_error "Some revert checks failed - tests do not guard their claimed changes"
  exit 1
elif [[ $ERRORS -gt 0 ]]; then
  log_error "Some revert checks had errors"
  exit 2
fi

log_ok "All revert checks passed!"
exit 0
