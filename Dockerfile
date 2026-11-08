FROM node:20-bookworm
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
ENV NODE_ENV=production PORT=5000
EXPOSE 5000
CMD ["npm","start"]
