#!/bin/bash
# Stub gate_submit command
echo "STUB:gate-submit:$*" >> /tmp/lair-stub-calls.log
echo "Gate submitted: track=$1 lane=$2 pri=$3"
exit 0
