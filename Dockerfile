FROM node:latest

RUN mkdir /app
WORKDIR /app

COPY ./index.js .
COPY ./package.json .
COPY ./.env.production .env
COPY ./private-key.pem ./private-key.pem

RUN npm install

EXPOSE 3000
CMD npm start
