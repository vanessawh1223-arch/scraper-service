#!/bin/bash
cd "$(dirname "$0")"
while true; do
  echo "[$(date)] Starting scraper service..."
  npx tsx index.ts
  EXIT_CODE=$?
  echo "[$(date)] Scraper service exited with code $EXIT_CODE, restarting in 3s..."
  sleep 3
done
