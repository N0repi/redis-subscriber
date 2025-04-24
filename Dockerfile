# Use a tiny Node.js base image
FROM node:18-alpine

# Create app directory
WORKDIR /usr/src/app

# Copy package manifests
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci --only=production

# Copy subscriber code
COPY worker.js ./

# Expose nothing (we don't serve HTTP)
# Declare your environment vars here as documentation:
# ENV UPSTASH_REDIS_REST_URL=...
# ENV UPSTASH_REDIS_REST_TOKEN=...
# ENV POD_KEY=...

# Default command
CMD ["node", "worker.js"]

