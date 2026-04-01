FROM node:20-slim AS base

# Install FFmpeg from system packages (avoids static binary SIGSEGV on Fargate)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node.js dependencies
COPY package.json ./
RUN npm install --production

# Copy application files
COPY subtitle-processor.js healthcheck.js entrypoint.sh ./
RUN chmod +x entrypoint.sh

# Expose ports: 5000 (UDP/RTP), 8080 (TCP/health check)
EXPOSE 5000/udp
EXPOSE 8080/tcp

ENTRYPOINT ["./entrypoint.sh"]
