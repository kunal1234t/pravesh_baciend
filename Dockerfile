FROM node:18-alpine

# Required for Strapi
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./

RUN npm install --production

COPY . .

ENV NODE_ENV=production

EXPOSE 6969

CMD ["npm", "run", "start"]
