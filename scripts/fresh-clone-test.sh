#!/bin/sh
set -e

echo "=== FRESH-CLONE QUICK-START TEST ==="
echo "Working directory: $(pwd)"
echo ""

echo "=== Step 1: npm install ==="
npm install 2>&1 | tail -5
echo ""

echo "=== Step 2: npm run typecheck ==="
npm run typecheck
echo ""

echo "=== Step 3: npm run build ==="
npm run build 2>&1 | tail -15
echo ""

echo "=== Step 4: npm test (summary) ==="
npm test 2>&1 | tail -15
echo ""

echo "=== FRESH-CLONE TEST COMPLETE ==="
