FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY dist/ dist/
COPY server/ server/
# A host checkout can contain files created with a private umask.
RUN chmod -R a+rX package.json dist server \
    && install -d -m 0700 -o node -g node /admin-data \
    && install -m 0600 -o node -g node /dev/null /admin-data/.keep
USER node
EXPOSE 8080 2525
CMD ["node", "server/main.js"]
