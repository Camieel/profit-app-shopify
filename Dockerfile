FROM node:20-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

COPY package.json package-lock.json* .npmrc ./

RUN npm ci --legacy-peer-deps && npm cache clean --force

COPY . .

RUN ./node_modules/.bin/prisma generate

ENV NODE_ENV=production

RUN npm run build

CMD ["npm", "run", "docker-start"]