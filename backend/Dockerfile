FROM node:20-bookworm

RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm install -g npm@11 && npm install --omit=dev --ignore-scripts

COPY . .

# Run unprivileged. /app stays root-owned and read-only for the process;
# writable state lives only in the mounted data volumes and /tmp.
# (Compose may pin the uid:gid to the owner of the host data directories.)
ENV HOME=/tmp
USER node

CMD ["node", "src/backend.cjs"]
