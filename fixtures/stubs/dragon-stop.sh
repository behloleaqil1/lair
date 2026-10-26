#!/bin/bash
# Stub dragon stop script for testing
# Records arguments to data/ for verification

DRAGON="$1"

echo "Stopping dragon: $DRAGON"

# Record the call
mkdir -p data
echo "dragon-stop $DRAGON" >> data/dragon-stop.log

exit 0
