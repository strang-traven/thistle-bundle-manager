FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY server ./server
COPY extensions/preorder-manager/src/logic.js ./extensions/preorder-manager/src/logic.js
COPY extensions/preorder-manager/src/insights.js ./extensions/preorder-manager/src/insights.js
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
USER node
CMD ["node","server/index.js"]
