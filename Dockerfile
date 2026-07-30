FROM node:20-alpine

# Required for Strapi build
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./

# 🔥 Fix npm network issues
RUN npm config set fetch-retries 5 \
 && npm config set fetch-retry-mintimeout 20000 \
 && npm config set fetch-retry-maxtimeout 120000 \
 && npm install

COPY . .

# 🔥 Build admin panel
RUN npm run build

ENV NODE_ENV=production

EXPOSE 6969

CMD ["npm", "run", "start"]