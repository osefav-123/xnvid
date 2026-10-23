FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip python-is-python3 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir --break-system-packages yt-dlp curl_cffi
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV HOST=0.0.0.0
CMD ["node", "app.js"]