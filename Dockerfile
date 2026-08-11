FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache ffmpeg python3 py3-pip ca-certificates \
 && python3 -m venv /opt/yt-dlp \
 && /opt/yt-dlp/bin/pip install --no-cache-dir --upgrade --pre "yt-dlp[default]"
ENV PATH="/opt/yt-dlp/bin:$PATH" NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
RUN mkdir -p downloads data
EXPOSE 3000
CMD ["node","src/index.js"]
