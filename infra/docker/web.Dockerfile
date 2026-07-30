FROM node:24-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/web/package.json apps/web/package.json
COPY packages/geometry/package.json packages/geometry/package.json
COPY packages/types/package.json packages/types/package.json
COPY packages/ai-router/package.json packages/ai-router/package.json
COPY packages/analytics/package.json packages/analytics/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN npm install

FROM node:24-alpine AS build
WORKDIR /app
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build --workspace @visualizer/web

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 3000
CMD ["npm", "run", "start", "--workspace", "@visualizer/web"]

