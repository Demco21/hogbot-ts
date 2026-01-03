FROM node:18-alpine AS builder

WORKDIR /app

# Install build dependencies for canvas
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    cairo-dev \
    jpeg-dev \
    pango-dev \
    giflib-dev \
    pixman-dev

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Production image
FROM node:18-alpine

WORKDIR /app

# Install runtime dependencies for canvas and fonts
RUN apk add --no-cache \
    cairo \
    jpeg \
    pango \
    giflib \
    pixman \
    ttf-dejavu \
    fontconfig && \
    fc-cache -fv

# Copy package files
COPY package*.json ./

# Copy built files and node_modules from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

# Create data directory for logs with proper permissions
RUN mkdir -p /app/data && chown -R node:node /app

# Run as non-root user for security
USER node

# Start the bot
CMD ["node", "dist/index.js"]
