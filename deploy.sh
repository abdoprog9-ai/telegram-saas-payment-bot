#!/usr/bin/env bash
set -e

echo "=========================================="
echo "🚀 [Deploy] Starting automated update on VPS"
echo "=========================================="

# 1. Fetch latest changes from GitHub
echo "📥 Fetching latest code from origin main..."
git fetch origin main
git reset --hard origin/main

# 2. Install dependencies
echo "📦 Installing dependencies..."
npm install --no-audit

# 3. Compile TypeScript
echo "🔨 Compiling TypeScript..."
npx tsc

# 4. Restart or Reload PM2 service
echo "🔄 Reloading PM2 service..."
if command -v pm2 &> /dev/null; then
    if pm2 describe telegram-saas > /dev/null 2>&1; then
        pm2 reload ecosystem.config.cjs --update-env
    else
        pm2 start ecosystem.config.cjs
    fi
    pm2 save
else
    echo "⚠️ PM2 not found globally"
fi

echo "=========================================="
echo "✅ [Deploy] Deployment finished successfully!"
echo "=========================================="
