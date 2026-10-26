#!/bin/sh
set -e
echo "=== npm install ==="
npm install
echo "=== typecheck ==="
npm run typecheck
echo "=== lint ==="
npm run lint
echo "=== test ==="
npm test
echo "=== build ==="
npm run build
echo "=== All checks passed ==="
