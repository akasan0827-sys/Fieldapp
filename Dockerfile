FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    TZ=Asia/Seoul
RUN apk add --no-cache tzdata && mkdir -p /data && chown node:node /data
COPY package.json ./
COPY server ./server
COPY public ./public
VOLUME ["/data"]
EXPOSE 3000
USER node
CMD ["node", "server/index.js"]
