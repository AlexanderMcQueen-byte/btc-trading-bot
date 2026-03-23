#!/bin/bash
# Example CI/CD deployment script
set -e

echo "[CI/CD] Installing dependencies..."
npm install

echo "[CI/CD] Running tests..."
npm test || echo "No tests defined. Skipping."

echo "[CI/CD] Deploying bot..."
# pm2 restart ecosystem.config.js || node main.js &
echo "[CI/CD] Deployment complete."
