# Fletcher as a ReviewBench agent. Build the bundle first (bench:rb-build),
# then build from this directory: the context is the bundle alone.
#   docker build --platform linux/amd64 -t ghcr.io/<you>/fletcher-reviewbench:v1 .
FROM node:24-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY dist/agent.mjs ./agent.mjs

# ReviewBench routes egress through HTTP(S)_PROXY; Node's fetch honours it
# only with this set.
ENV NODE_USE_ENV_PROXY=1

ENTRYPOINT ["node", "/app/agent.mjs"]
