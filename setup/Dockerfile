FROM node:22-alpine
# Which app image the wizard writes into docker-compose.yml (see server.js).
ARG KOWLOON_VERSION=latest
ENV KOWLOON_VERSION=${KOWLOON_VERSION}
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js index.html ./
EXPOSE 2999
CMD ["node", "server.js"]
