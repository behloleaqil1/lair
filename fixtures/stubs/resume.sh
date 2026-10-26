#!/bin/bash
# Stub resume command - removes STOP file
STOP_FILE="${1:-/tmp/lair-test-STOP}"
echo "STUB:resume:$*" >> /tmp/lair-stub-calls.log
rm -f "$STOP_FILE"
echo "Orchestrator resumed"
exit 0
