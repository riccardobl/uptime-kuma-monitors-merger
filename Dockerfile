FROM node:22.23.4-bookworm-slim

RUN mkdir -p /app
WORKDIR /app
COPY package.json package-lock.json ./

RUN npm ci --omit=dev --ignore-scripts

COPY index.js ./

RUN groupadd -r app && useradd -r -g app app
USER app

ENTRYPOINT ["node", "index.js"]


