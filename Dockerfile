FROM node:latest

RUN mkdir /app
WORKDIR /app

COPY ./package.json .
RUN npm install

COPY ./.env.production .env
COPY ./private-key.pem ./private-key.pem

COPY ./index.js .

EXPOSE 3000
CMD npm start
