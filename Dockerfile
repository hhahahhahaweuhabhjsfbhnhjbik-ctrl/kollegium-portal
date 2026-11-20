FROM node:24-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY advokate.html server.mjs webhooks.mjs discord-bot.mjs ./
COPY assets ./assets
COPY data/laws ./data/laws
COPY desktop ./desktop
COPY integrations ./integrations
COPY web ./web

ENV HOST=0.0.0.0
ENV PORT=3000
ENV NODE_ENV=production
ENV COOKIE_SECURE=true
ENV DB_PATH=/tmp/portal.sqlite

EXPOSE 3000

CMD ["node", "--env-file-if-exists=.env", "server.mjs"]
