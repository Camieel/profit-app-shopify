FROM node:20-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* .npmrc ./

# Install ALL deps including dev (needed for prisma CLI)
RUN npm ci --legacy-peer-deps && npm cache clean --force

RUN ./node_modules/.bin/prisma generate

COPY . .

RUN npm run build

CMD ["npm", "run", "docker-start"]