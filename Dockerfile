FROM node:20-slim
WORKDIR /app

# Copy backend package files first for layer caching
COPY backend/package*.json ./
RUN npm install

# Copy all backend source and build
COPY backend/ ./
RUN npm run build
RUN npx prisma generate

EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
