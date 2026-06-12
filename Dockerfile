FROM mcr.microsoft.com/playwright:v1.60.0-noble

WORKDIR /app

# Copy package files
COPY package.json ./

# Skip downloading browsers - they're already in the Docker image
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Install Node.js dependencies only (no browser download)
RUN npm install --production

# Build the TypeScript to JavaScript
RUN npx esbuild index.ts --outfile=index.js --platform=node --format=cjs --target=node24

# Copy source code
COPY index.ts ./

# Expose port
EXPOSE 3001

# Set environment
ENV NODE_ENV=production
ENV PORT=3001

# Start the service with GC enabled
CMD ["node", "--expose-gc", "index.js"]
