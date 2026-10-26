#!/bin/bash
# Stub ask command - records args and outputs a fake response
echo "STUB:ask:$*" >> /tmp/lair-stub-calls.log
echo "Answer: This is a stub response to your question."
exit 0
