FROM node:20-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*


WORKDIR /usr/src/app


COPY package*.json ./


RUN npm install --omit=dev


COPY . .

CMD ["npm", "start"]