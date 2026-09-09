# The coordinator, in a container.
#
# It runs the TypeScript through tsx, the same way `npm run server` does. There is no
# JavaScript build step in this repo, and inventing one only for the image would mean the
# deployed thing and the developed thing are produced by different toolchains - which is
# exactly the difference that is invisible until it is the cause.
#
# The step that is easy to leave out is `npm run build`. `artifacts/` is gitignored, and
# `PoolsClient` reads the contract ABI out of it lazily, on the first lookup that touches the
# chain. Without it the image starts, answers /healthz, lists its resources - and then 500s on
# the first real request. A container that boots is not a container that works.
FROM node:22-slim

WORKDIR /app

# Dependencies before source, so editing a handler does not reinstall the tree.
#
# The whole tree, devDependencies included: tsx runs the server and hardhat compiles the
# contract, and both are needed here. `--omit=dev` would save a few hundred megabytes and
# produce an image that cannot start.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# The ABI. See above.
RUN npm run build

ENV NODE_ENV=production
ENV PORT=4021
EXPOSE 4021

# `--import tsx` registers the loader in this process rather than spawning a child, so the
# server is PID 1 and gets Fly's SIGTERM directly. Through `tsx` or `npm run`, the signal
# stops at the wrapper and the machine waits out its kill timeout on every deploy.
CMD ["node", "--import", "tsx", "src/server/index.ts"]
