# Use official lightweight Node.js image
FROM node:20-alpine

# Set working directory
WORKDIR /usr/src/app

# Install system dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++ sqlite

# Copy package files and install dependencies
COPY package.json package-lock.json* ./
RUN npm install --production

# Copy source code
COPY . .

# Expose no ports (MCP uses stdio)
ENV NODE_ENV=production

# Default command
CMD ["npm", "start"]
