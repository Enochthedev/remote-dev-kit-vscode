# Contributing

Moved out of `README.md` because that file is rendered as the extension's
Marketplace page — build and release steps are noise to someone deciding whether to install it.

## Local development

```bash
npm install
npm run compile        # bundle with esbuild → dist/
npm run lint           # tsc --noEmit
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host.

## Packaging

```bash
npx @vscode/vsce package                          # → remote-dev-kit-<version>.vsix
code --install-extension remote-dev-kit-*.vsix    # try it in your editor
```

## Releasing to the Marketplace

`vsce` isn't installed globally, so every command below is prefixed with `npx`.
Install it once with `npm i -g @vscode/vsce` if you'd rather type `vsce` alone.

### One-time setup

1. **Create the publisher in the browser.** Go to
   [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage)
   and sign in with a Microsoft account.
   (There used to be a `vsce create-publisher` command. It was removed; the web
   UI is the only way now.)
   The form has separate **Name** and **ID** fields. Name is the display name;
   **ID is the identifier `vsce` uses**, and it must be exactly `wavestudio`
   to match `"publisher"` in `package.json`. Setting a display name and letting
   the ID auto-generate is the usual cause of the error below.

   Sign in with the **same Microsoft account** you use for Azure DevOps. A
   publisher owned by one account and a PAT issued from another produces the
   same failure.

2. **Create an Azure DevOps organization**, if you've never used one.
   This is the step that makes the tokens page impossible to find: personal
   access tokens live *under an organization*, so with none created
   [dev.azure.com](https://dev.azure.com) shows a "create an organization"
   flow and no settings to speak of. Any name works, nothing is published
   there, it only exists to own the token.

   Azure DevOps will then push you to create a *project* inside the org. You
   don't need one. Projects hold repos, boards and pipelines; none of that is
   involved in publishing. Skip it, or make one and ignore it.

3. **Generate a Personal Access Token.**
   In [dev.azure.com](https://dev.azure.com), select your organization, then
   open the **user settings dropdown next to your profile image** (not the
   profile image itself) and choose **Personal access tokens** → **New Token**.

   Direct link once the org exists:
   `https://dev.azure.com/<your-org>/_usersSettings/tokens`

   - Organization: **All accessible organizations**. Scoped to a single org it
     fails with a 403 at publish time.
   - Name: anything, it's only a label. Expiration: your call, re-issue when
     it lapses.
   - Scopes: **Custom defined**. The list you see first (Work Items, Code,
     Build, Release, Test Management, Packaging) does **not** contain
     Marketplace — click **Show all scopes (30 more)** and it appears there.
     Tick **Marketplace → Manage** (not Read or Acquire; Manage covers both).
   - Copy it immediately, it isn't shown again.

4. **Log in and check the token works:**

```bash
npx @vscode/vsce login wavestudio      # paste the PAT
npx @vscode/vsce verify-pat wavestudio # confirms it before you rely on it
```

### If `vsce login` says "Access Denied ... on the resource /wavestudio"

It looks like a token problem and usually isn't. `vsce login` verifies the token
*against a publisher*, so it fails here when the publisher doesn't exist, or
exists under a different Microsoft account than the one that issued the PAT.

Check in this order:

1. Does [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage)
   show a publisher dashboard, or a **Create publisher** button? A button means
   it was never created.
2. Is the publisher's **ID** (not its display name) exactly `wavestudio`?
3. Is the account signed into the Marketplace the same one that owns the PAT?

Only once all three are right is it worth suspecting the token's scope or
organization setting.

### Each release

```bash
npx @vscode/vsce publish patch    # or minor | major — bumps the version and publishes
```

The Marketplace rejects a re-publish of an existing version, so let `publish`
do the bump rather than doing it by hand.

Update `CHANGELOG.md` first; VS Code renders it on the extension page.

### Before the first publish

- `icon` must be a PNG of at least 128×128. SVG is rejected.
- README images cannot be SVG either, except badges from trusted providers.
- Anything not needed at runtime belongs in `.vscodeignore` — check the package
  size with `vsce ls` before shipping.
