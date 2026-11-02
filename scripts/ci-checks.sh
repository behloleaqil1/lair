#!/bin/sh
set -e
echo "=== install-script policy ==="
npm run check:install-scripts
echo "=== npm install ==="
npm install
echo "=== allowed install scripts ==="
npm run rebuild:native
echo "=== typecheck ==="
npm run typecheck
echo "=== lint ==="
npm run lint
echo "=== test ==="
npm test
echo "=== build ==="
npm run build
echo "=== All checks passed ==="
