FROM node:16

RUN mkdir -p /app
WORKDIR /app
ADD . /app

RUN npm i --production

RUN groupadd -r app && useradd -r -g app app
RUN chown -R app:app /app
USER app

ENTRYPOINT ["node", "index.js"]


