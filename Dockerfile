FROM node:15.4.0-alpine3.12

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install --only=production

COPY . .

EXPOSE 3000

CMD [ "npm", "start" ]