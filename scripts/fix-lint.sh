#!/bin/sh
set -e
echo "=== npm install ==="
npm install
echo "=== lint fix ==="
npm run lint -- --fix || true
echo "=== Done ==="
