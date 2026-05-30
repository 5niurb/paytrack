# paytrack on Fly.io — Express + Supabase, uses sharp (native) so build on linux.
FROM node:22-slim

WORKDIR /app

# Install production deps. sharp ships prebuilt linux binaries for node 22,
# so no extra build toolchain is needed for the default install.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
