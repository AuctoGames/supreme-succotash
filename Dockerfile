# Use Node.js 20 Alpine as base image for smaller size
FROM node:20-alpine AS base

# Install system dependencies needed for some packages
RUN apk add --no-cache libc6-compat

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only (no dev, no optional)
FROM base AS deps
RUN npm ci --omit=dev --omit=optional && npm cache clean --force

# Build stage - needs all dependencies including vite
FROM base AS build
COPY package*.json ./
RUN npm ci --include=optional
COPY . .
RUN npm run build

# Production stage
FROM node:20-alpine AS production

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create app user for security
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nextjs -u 1001

# Set production environment variables
ENV NODE_ENV=production
ENV PORT=5000

WORKDIR /app

# Copy built application and production dependencies (without vite)
COPY --from=deps --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=nextjs:nodejs /app/dist ./dist
COPY --from=build --chown=nextjs:nodejs /app/package.json ./package.json

# Switch to non-root user
USER nextjs

# Expose port
EXPOSE 5000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:5000/api/health || exit 1

# Start the application with dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"] 