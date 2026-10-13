FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npm run build

# session + data live on the mounted volume
ENV AUTH_DIR=/data/auth
ENV DB_FILE=/data/trackwapp.json
ENV PORT=3000
EXPOSE 3000

CMD ["node", "dist/server.js"]
