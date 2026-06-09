FROM node:20-slim

# Install all Playwright system dependencies
RUN apt-get update && apt-get install -y \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libxshmfence1 \
    libxfixes3 \
    libx11-xcb1 \
    libxcb-dri3-0 \
    libdbus-1-3 \
    libatspi2.0-0 \
    libexpat1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies
RUN npm install

# Install Playwright browsers with system dependencies
RUN npx playwright install chromium --with-deps

# Copy source code
COPY index.ts ./

# Expose port
EXPOSE 3001

# Set environment
ENV NODE_ENV=production
ENV PORT=3001

# Start the service
CMD ["npx", "tsx", "index.ts"]
