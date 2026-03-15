FROM node:24.4.0-alpine3.22 AS builder

# Must be entire project because `prepare` script is run during `npm install` and requires all files.
COPY . /app

WORKDIR /app

# Install all dependencies (including devDependencies) for building
RUN --mount=type=cache,target=/root/.npm npm install

# Build the project (this will use the devDependencies like typescript and shx)
RUN npm run build

FROM node:24.4.0-alpine3.22 AS release

# Install tini for proper signal handling
RUN apk add --no-cache tini

COPY --from=builder /app/dist /app/dist
COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/package-lock.json /app/package-lock.json

ENV NODE_ENV=production

WORKDIR /app

RUN npm ci --ignore-scripts --omit-dev

# Install the package globally to make slack-mcp command available
RUN npm install -g .

# Use tini as PID 1 for proper signal handling
ENTRYPOINT ["tini", "--", "slack-mcp"]

# Default: REST API (HTTP transport) on port 3000
# Override for stdio: docker run ... slack-mcp-server --transport stdio
CMD ["--transport", "http", "--port", "3000"]
