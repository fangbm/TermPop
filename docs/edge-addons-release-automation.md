# Microsoft Edge Add-ons release automation

TermPop can submit updates to the existing Microsoft Edge Add-ons listing from
the `Build Extension Release` GitHub Actions workflow. The store still runs
its own certification after the upload; the workflow only waits for Microsoft
to accept the package and submission request.

## One-time Partner Center setup

1. Open **Microsoft Edge > Publish API** in Partner Center for the account that
   owns TermPop.
2. Enable the new Publish API experience and create API credentials.
3. Copy the displayed Client ID and API key. Copy the product ID from the
   TermPop overview URL or its Extension identity section.

## GitHub configuration

Create these repository Actions secrets:

- `EDGE_ADDONS_PRODUCT_ID`
- `EDGE_ADDONS_CLIENT_ID`
- `EDGE_ADDONS_API_KEY`

Then add the repository Actions variable `EDGE_ADDONS_PUBLISH_ENABLED` with
the exact value `true`. Until this variable is set, release builds continue
to publish only their GitHub Release and skip the Edge step.

## Release behavior

- Pushing a version tag such as `v0.1.4` builds the ZIP, creates the GitHub
  Release, uploads the same ZIP to Edge, and submits the resulting draft.
- A manually dispatched release can submit to Edge by checking
  `publish_edge_addons`.
- The manifest and extension package version must match the release tag.
- The API cannot create a new listing or edit storefront metadata. Those
  changes remain in Partner Center.

If a previous Edge submission is still being processed, resolve or withdraw it
in Partner Center before starting another automated update.
