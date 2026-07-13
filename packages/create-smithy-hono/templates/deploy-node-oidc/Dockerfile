# API container for the Node target. Runs the server via tsx (no compile step),
# matching the golden-path dev workflow. The build context is the project root;
# `src/generated/` MUST be present (run `npm run codegen` before deploying — the
# @smithy-hono/deploy-node CLI's build step assumes it exists).
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production PORT=3000

# Install deps first for layer caching. The @smithy-hono/* packages resolve from
# the public npm registry.
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

# App source (incl. the gitignored src/generated produced by `npm run codegen`).
COPY . .

# Run as the built-in non-root `node` user.
USER node
EXPOSE 3000
CMD ["npx", "tsx", "src/server.ts"]
