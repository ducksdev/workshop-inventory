FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY dist ./dist
COPY public ./public
COPY keys/public.pem ./keys/public.pem
ENV PORT=3100 DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3100
CMD ["node", "dist/index.js"]
