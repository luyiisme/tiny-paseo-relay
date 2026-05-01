FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/
RUN npm run build

FROM node:20-alpine
RUN addgroup -S relay && adduser -S relay -G relay
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist/ ./dist/
USER relay
EXPOSE 39217
ENV HOST=0.0.0.0
ENV PORT=39217
CMD ["node", "dist/index.js"]
