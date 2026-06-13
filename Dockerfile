FROM mcr.microsoft.com/playwright:v1.60.0-noble

WORKDIR /app

# Copy source files
COPY package.json ./
COPY index.ts ./

# Skip downloading browsers - they're already in the Docker image
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Install Node.js dependencies only (no browser download)
RUN npm install --production

# Build the TypeScript to JavaScript
RUN npx esbuild index.ts --outfile=index.js --platform=node --format=cjs --target=node24

# Expose port
EXPOSE 3001

# Set environment
ENV NODE_ENV=production
ENV PORT=3001

# Start the service with GC enabled and memory limit
CMD ["node", "--expose-gc", "--max-old-space-size=512", "index.js"]
