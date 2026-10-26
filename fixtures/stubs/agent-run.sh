#!/bin/bash
# Stub agent_run command
echo "STUB:agent-run:TASK=$TASK:$*" >> /tmp/lair-stub-calls.log
if [ -z "$TASK" ]; then
  echo "Error: TASK not set" >&2
  exit 1
fi
echo "Agent started with task: $TASK"
exit 0
