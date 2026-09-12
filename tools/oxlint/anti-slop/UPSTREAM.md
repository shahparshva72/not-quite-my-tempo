# Anti-slop provenance

Source: the `install-anti-slop` skill bundled in this repository at
`.agents/skills/install-anti-slop/assets/anti-slop/`.

Source revision: unknown. The bundled skill is not tracked by this repository, so
no source commit can be recovered. At installation time, the SHA-256 digest of the
sorted per-file SHA-256 manifest was
`e0778e9f7e2a3b779b31a8085bf7c3b3e604ba21fb6f37126b485197ca3a0e42`.

Installed plugin paths:

- `tools/oxlint/anti-slop/index.ts`
- `tools/oxlint/anti-slop/effect/index.ts`

Intentional deviations: none. The generic plugin and the optional Effect plugin
were copied without modification. The repository enables the Effect rules because
`effect` is a direct dependency in its package manifests.

The nested `vendor/eslint-stylistic/UPSTREAM.md` records the separate provenance
for the vendored readability-rule implementation.
