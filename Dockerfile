FROM node:20-slim
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    DEBIAN_FRONTEND=noninteractive

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev \
 && npx playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/*

COPY . .

ENV DATA_DIR=/data
VOLUME ["/data"]

EXPOSE 8000

# Diretso na sa node, walang Xvfb
CMD ["node", "server.js"]
