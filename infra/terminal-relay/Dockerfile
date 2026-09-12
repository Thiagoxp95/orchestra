FROM oven/bun:1.3.0 AS build
WORKDIR /app
COPY apps/terminal-relay/package.json ./package.json
RUN bun install --ignore-scripts
COPY apps/terminal-relay/src ./src
RUN bun run build
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./package.json
RUN npm install --omit=dev --ignore-scripts
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
