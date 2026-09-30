# web-mcp container. Zero npm dependencies: nothing is installed at build time.
# After the first build, pin the base image to the digest you pulled
# (README, step 2) so a later rebuild cannot silently change it.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

ENV NODE_ENV=production
WORKDIR /app
COPY package.json index.js ./
COPY lib/ ./lib/

# Unprivileged user that ships with the official image.
USER node
ENTRYPOINT ["node", "/app/index.js"]
