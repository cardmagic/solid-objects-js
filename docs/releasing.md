# Releasing

Publishing is driven by version tags and npm Trusted Publishing. GitHub Actions
uses a short-lived OpenID Connect identity, so the repository does not need an
npm token.

## npm trusted publisher

The `solid-objects` package must authorize this GitHub Actions identity:

- Organization or user: `cardmagic`
- Repository: `solid-objects-js`
- Workflow filename: `ci.yml`
- Environment: none
- Allowed action: `npm publish`

The relationship can be created while authenticated as a package owner:

```shell
npm trust github solid-objects \
  --repo cardmagic/solid-objects-js \
  --file ci.yml \
  --allow-publish \
  --yes
```

## Release procedure

1. Update the version in `package.json` and `src/version.ts`, refresh the
   lockfile when needed, and move the release notes out of the Unreleased
   section in `CHANGELOG.md`.
2. Run `pnpm run format:check`, `pnpm run check`, `pnpm run test:coverage`,
   `pnpm run build`, `pnpm run pack:check`, `pnpm run test:package`,
   `pnpm run test:recovery`, `pnpm run test:browser`, and
   `pnpm audit --audit-level=high`. Run the PostgreSQL, MySQL, and Redis jobs
   against the versions in [the support matrix](support.md).
3. Commit and push `main`.
4. Create and push an annotated tag matching the package version:

   ```shell
   git tag -a v0.13.1 -m "Version 0.13.1"
   git push origin v0.13.1
   ```

The tag runs the complete CI matrix. The publish job starts only after every
quality, database, Redis, and browser job succeeds. It rejects tags that do not
match `package.json`, safely skips versions already present in npm, and
publishes new versions with npm provenance.
