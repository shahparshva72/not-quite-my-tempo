# ReviewBench agent

Runs Fletcher on [ReviewBench](https://review-bench.ai): 219 public pull
requests in 19 languages, judged by ReviewBench with the model key you
supply for reviews. ReviewBench starts this image once per pull request with
the repository checked out at its head (see ReviewBench's
`AGENT_CONTRACT.md`); `agent.ts` builds Fletcher's production prompt from
that checkout, adds related code (callers of changed symbols and tests of
changed files, found with `git grep`), reviews, and writes `findings.json`.

## Build

From the repository root:

```sh
pnpm --filter @not-quite-my-tempo/api bench:rb-build
cd apps/api/scripts/review-bench
docker build --platform linux/amd64 -t ghcr.io/<you>/fletcher-reviewbench:v1 .
docker push ghcr.io/<you>/fletcher-reviewbench:v1
docker inspect --format '{{index .RepoDigests 0}}' ghcr.io/<you>/fletcher-reviewbench:v1
```

The build context is the bundle alone (see `.dockerignore`), so nothing
else from the repository, `.dev.vars` included, reaches the image.

## Register

In the ReviewBench portal, register the digest with:

- Model API URL: `https://generativelanguage.googleapis.com` for an AI
  Studio key, or `https://aiplatform.googleapis.com` for a Vertex AI
  express key.
- Secret: `GEMINI_API_KEY`.
- Configuration labels, read as `RB_CONFIG_*`:
  - `model`: catalog model id (default `gemini-3.8-flash`)
  - `provider`: `gemini_api` (AI Studio) or `vertex_express`
  - `strategy`: `single` or `specialists`
  - `context`: `related` (default) or `basic`, to measure related code

Free-tier keys hit rate limits; the agent retries them for up to a few
minutes per call, inside ReviewBench's 30-minute limit per pull request.

## Check locally

Mount a self-contained clone (not `git clone --shared`: its objects live
outside the mount) the way ReviewBench does, and set `FLETCHER_DRY_RUN=1`
to print the prompt size and related snippets without calling a model:

```sh
docker run --rm --platform linux/amd64 \
  -v "$PWD/repo:/work/repo" -v "$PWD/pr:/work/pr:ro" -v "$PWD/out:/work/out" \
  -e RB_NWO=owner/repo -e RB_PR_NUMBER=1 -e RB_BASE=<sha> -e RB_HEAD=<sha> \
  -e RB_AGENT=fletcher -e RB_DIFF=/work/pr/diff.patch \
  -e RB_PR_JSON=/work/pr/pr.json -e RB_OUT=/work/out/findings.json \
  -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
  -e FLETCHER_DRY_RUN=1 fletcher-reviewbench:dev
```
