#!/bin/bash
# One-time setup: deploy the Cloudflare Worker for image proxying
# This makes it IMPOSSIBLE for Render to ever run out of bandwidth

echo "=== Cloudflare Worker Deploy ==="
echo ""
echo "Step 1: Login to Cloudflare (opens browser)"
echo "Step 2: Deploy the worker"
echo ""

cd "$(dirname "$0")"

echo "Logging in to Cloudflare..."
npx wrangler login

echo ""
echo "Deploying worker..."
npx wrangler deploy

echo ""
echo "=== DONE ==="
echo ""
echo "Your worker is live at:"
echo "  https://jerzees-img-proxy.<your-subdomain>.workers.dev"
echo ""
echo "Now update the frontend proxyImg() function to use this URL."
echo "See DEPLOY.md for details."
