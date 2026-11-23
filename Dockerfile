FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY dist/ dist/
COPY server/ server/
USER node
EXPOSE 8080 2525
CMD ["node", "server/main.js"]
