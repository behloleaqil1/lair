#!/bin/bash
# Stub pause command - creates STOP file
STOP_FILE="${1:-/tmp/lair-test-STOP}"
echo "STUB:pause:$*" >> /tmp/lair-stub-calls.log
touch "$STOP_FILE"
echo "Orchestrator paused"
exit 0
