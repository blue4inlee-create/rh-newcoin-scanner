FROM node:22-alpine
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src/ ./src/
RUN cat src/rh_newcoin_scanner_v1.part* > rh_newcoin_scanner_v1.mjs \
 && echo "a03ae7dda84e4db8322b912756c176911b419d2e7bdff968aedd4abb3909684c  rh_newcoin_scanner_v1.mjs" | sha256sum -c -

ENV NODE_ENV=production
ENV DRY_RUN=1
EXPOSE 3000
CMD ["npm", "start"]
