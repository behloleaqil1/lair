#!/bin/bash
# Stub dragon start script for testing
# Records arguments to data/ for verification

DRAGON="$1"
TASK="$2"
PROMPT_FILE="$3"

echo "Starting dragon: $DRAGON"
echo "Task: $TASK"
echo "Prompt file: $PROMPT_FILE"
echo "Model override: ${MODEL:-none}"
echo "Extra instructions: ${EXTRA_INSTRUCTIONS:-none}"

# Record the call
mkdir -p data
echo "dragon-start $DRAGON $TASK $PROMPT_FILE MODEL=$MODEL" >> data/dragon-start.log

exit 0
