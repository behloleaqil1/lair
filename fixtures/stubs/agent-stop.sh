#!/bin/bash
# Stub agent_stop command
echo "STUB:agent-stop:$*" >> /tmp/lair-stub-calls.log
echo "Agent stopped: $1"
exit 0
