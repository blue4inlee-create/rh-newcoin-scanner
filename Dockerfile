FROM node:22-alpine
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src/ ./src/
RUN cat src/rh_newcoin_scanner_v1.part* > rh_newcoin_scanner_v1.mjs \
 && node --check rh_newcoin_scanner_v1.mjs

ENV NODE_ENV=production
ENV DRY_RUN=1
EXPOSE 3000
CMD ["npm", "start"]
