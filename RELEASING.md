# Releasing

Releases run only by hand: **Actions → Release → Run workflow** on `main`. `.github/workflows/release.yml` then:

1. **build** — reads `version` from `packages/client/package.json` and stops if `v<version>` is already tagged. Runs lint, typecheck, unit tests, the production build and the VS Code 1.85 e2e suite, then packages the VSIX.
2. **draft** — creates a draft GitHub release `v<version>` targeting the commit being released and attaches the VSIX. A draft doesn't create its tag yet.
3. **publish** — runs in the protected `release` environment. Signs in to Azure as a managed identity (no stored Marketplace token) and publishes to the Visual Studio Marketplace, then to Open VSX. Both use `--skip-duplicate`, so re-running a half-finished release is safe.
4. **release** — publishes the draft, which creates the `v<version>` tag.

## One-time setup

### 1. Marketplace publisher

Sign in at <https://marketplace.visualstudio.com/manage> with your Microsoft account and create a publisher (`<publisher>` below). It must match `publisher` in the manifest, and the ID can't be changed later.

### 2. Azure managed identity

Only global Azure DevOps Personal Access Tokens can publish to the Marketplace, and Azure DevOps retires them on December 1, 2026. CI signs in as an Azure managed identity instead.

1. Create a free Azure account at <https://azure.microsoft.com/free> if you don't have a subscription. The identity is an Azure resource and needs one; it costs nothing.
2. In the Azure portal at <portal.azure.com>, open **Managed Identities → Create**. Pick the subscription, a resource group (e.g. `css-modules-devtools`), any region and a name (e.g. `css-modules-devtools-publisher`). Use a managed identity, as Microsoft's publishing guide does; there are reports of App Registrations signing in but being refused at publish with `operation not allowed`.
3. Open the identity itself, not its resource group (**Resource group → Overview →** the Managed Identity resource), then **Settings → Federated credentials → Add credential**:
   - Scenario: **GitHub Actions deploying Azure resources**
   - Organization: `<owner>` (the repo owner's GitHub login, also for personal accounts)
   - Organization ID and Repository ID: the numeric IDs, from `gh api users/<owner> --jq .id` and `gh api repos/<owner>/<repo> --jq .id`
   - Repository: `<repo>`
   - Entity type: **Environment**, Environment name: `release`
   - Name: e.g. `github-release`

   The subject identifier should read `repo:<owner>@<owner-id>/<repo>@<repo-id>:environment:release`. Repositories created or renamed after July 15, 2026 send this ID-based subject; check yours with `gh api repos/<owner>/<repo>/actions/oidc/customization/sub` (`use_immutable_subject: true`). This trusts any run of a job in the `release` environment, whatever triggered it.

4. On the identity's **Overview**, copy the **Client ID** and the **Tenant ID** (the tenant is under **Properties** if it isn't shown).

### 3. Open VSX

1. Sign in at <https://open-vsx.org> with GitHub and link an Eclipse account under **Settings**.
2. Sign the **Eclipse Foundation Open VSX Publisher Agreement** from the same page.
3. Create an access token under **Settings → Access Tokens**.
4. Create the namespace once: `bunx ovsx create-namespace <publisher> -p <token>`.

### 4. GitHub environment

1. **Settings → Environments → New environment** named `release`. Add yourself as a required reviewer. Under **Deployment branches and tags**, choose **Selected branches and tags** and add `main`.
2. In that environment, add the **secrets** `AZURE_CLIENT_ID` and `AZURE_TENANT_ID` (from step 2.4) and `OVSX_PAT` (from step 3.3). Or from a terminal:

   ```sh
   gh secret set AZURE_CLIENT_ID --env release
   gh secret set AZURE_TENANT_ID --env release
   gh secret set OVSX_PAT --env release
   ```

### 5. Add the identity to the publisher

The Marketplace knows the identity by its Azure DevOps profile ID, not its Client ID. Only the identity itself can read that ID, so run a throwaway workflow once:

1. Commit this as `.github/workflows/whoami.yml` and push it to `main`:

   ```yaml
   name: Marketplace identity
   on: workflow_dispatch
   permissions:
     id-token: write
   jobs:
     whoami:
       runs-on: ubuntu-latest
       environment: release
       steps:
         - uses: azure/login@053f7285eb20bf5469ef084617b0b24d3cec53fc # v3.1.0
           with:
             client-id: ${{ secrets.AZURE_CLIENT_ID }}
             tenant-id: ${{ secrets.AZURE_TENANT_ID }}
             allow-no-subscriptions: true
         - run: az rest -u https://app.vssps.visualstudio.com/_apis/profile/profiles/me --resource 499b84ac-1321-427f-aa17-267ca6975798 --query id -o tsv
   ```

2. Run it from **Actions → Marketplace identity → Run workflow**, approve the `release` environment, and copy the ID the last step prints.
3. At <https://marketplace.visualstudio.com/manage>, open your publisher → **Members → Add**, paste the ID and give it the **Contributor** role. If the search finds nothing, you pasted the Client ID instead.
4. Delete `whoami.yml`.

## Cutting a release

1. Bump `version` in `packages/client/package.json`. The root `package.json` version is not used.
2. Add a `## X.Y.Z` section at the top of `CHANGELOG.md`. The build copies it into the VSIX, where the Marketplace shows it on the Changelog tab.
3. Run the checks locally:

   ```sh
   bun run check && bun run typecheck && bun test packages && bun run test:e2e && bun run package
   ```

4. Commit and push to `main`. README images on the listing load from `main`, so push before releasing.
5. **Actions → Release → Run workflow** on `main`, then approve the `publish` job when it waits on the `release` environment.

If a job fails, use **Re-run failed jobs**. A new run for the same version reuses the draft and points it at the new commit.

## Credentials

- **Marketplace:** nothing expires. If publishing fails with `operation not allowed`, check the identity is still a Contributor on the publisher. If `azure/login` fails, check the federated credential still names the `release` environment.
- **Open VSX:** rotate `OVSX_PAT` if Open VSX rejects it.
