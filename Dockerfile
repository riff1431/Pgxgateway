# Stage 1: Build the TypeScript backend
FROM node:22-alpine AS builder

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install all dependencies including devDependencies for TypeScript compilation
RUN npm ci

# Copy source code and configurations
COPY . .

# Compile TypeScript to JavaScript (outputs to dist/)
RUN npm run build

# Stage 2: Production runner
FROM node:22-alpine AS runner

WORKDIR /app

# Set production environment
ENV NODE_ENV=production
ENV PORT=5000

# Copy dependency manifests
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev

# Copy compiled dist from builder stage
COPY --from=builder /app/dist ./dist

# Run as non-root user for security
USER node

# Expose backend port
EXPOSE 5000

# Start production server
CMD ["node", "dist/server.js"]
