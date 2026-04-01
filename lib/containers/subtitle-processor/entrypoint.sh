#!/bin/bash
set -e

echo "Starting health check server..."
node /app/healthcheck.js &

echo "Starting subtitle processor..."
exec node /app/subtitle-processor.js
