---
name: bundle-tools
description: Bundle a released tag of the tool registry (apachler/aprscaching-tools) into the web app with tools/toolkey/bundle-registry.mjs, run the gate and open a pull request into dev. Use for "/bundle-tools <vX.Y.Z>", "bundle the tools release", "take registry v1.2.0 into the app", "update the bundled tools". Never merges.
---

# Bundle a tool registry tag

`/bundle-tools <vX.Y.Z>` takes a released registry tag into `apps/web/public/tools/`, the registry every instance
serves at `/tools/registry.json`, on the branch `chore/bundle-tools-vX.Y.Z`, and opens the pull request into `dev`.

## Rules

- Never merge the pull request, and never push to `dev` or `main`. Merging waits for the user's go-ahead in the
  conversation.
- The bundle is the tag's files as published: never edit anything under `apps/web/public/tools/` by hand. When
  `bundle-registry.mjs` fails, it has written nothing; report its `FAIL` line and stop.
- The branch is cut from a freshly fetched `origin/dev`, and the user's checkout is left as it is (see step 3).
- Commits are Conventional Commits, signed off (`git commit -s`), with no tool attribution in commits or the PR.
- Run every command in the foreground.

`$T` is the tag (`v1.2.0`), `$S` a scratch folder (the session's scratchpad, else a `mktemp -d`).

## Steps

1. **The tag is a release.**

    ```bash
    gh release view "$T" -R apachler/aprscaching-tools --json tagName,url,publishedAt
    ```

    No release, no bundle: tell the user the tag has not been released (`/release` in the tools repository).

2. **Check out the tag in a temporary worktree.** With a local clone of the tools repository
   (`~/Development/github/aprscaching-tools`):

    ```bash
    TOOLS=~/Development/github/aprscaching-tools
    git -C "$TOOLS" fetch origin --tags
    git -C "$TOOLS" merge-base --is-ancestor "$T" origin/main   # the tag is on main
    git -C "$TOOLS" worktree add --detach "$S/aprscaching-tools-$T" "$T"
    ```

    Without one: `git clone --depth 1 --branch "$T" https://github.com/apachler/aprscaching-tools.git "$S/aprscaching-tools-$T"`.

3. **Branch from `origin/dev`.**

    ```bash
    git -c url."https://github.com/".insteadOf="git@github.com:" fetch origin
    ```

    When the checkout is clean (`git status --porcelain` prints nothing), `git switch -c chore/bundle-tools-$T origin/dev`
    there. Otherwise work in a worktree, so the user's changes stay untouched:
    `git worktree add "$S/aprscaching-bundle-$T" -b chore/bundle-tools-$T origin/dev`, then run the next steps in it,
    starting with `pnpm install --frozen-lockfile`.

4. **Bundle.**

    ```bash
    node tools/toolkey/bundle-registry.mjs "$T" --source "$S/aprscaching-tools-$T"
    git status --short apps/web/public/tools
    ```

    It checks the registry's signature against the key pinned in `packages/shared/src/toolregistries.ts`, every
    manifest against its entry's author key, every script against its `entrySha256`, and the tool API each manifest
    needs against `packages/tools/src/api.ts`. A tool needing a newer tool API than the app implements waits for the
    app release that implements it: report it and stop. Summarise the change for the user: tools added, removed, and
    each version that moved (compare `registry.json` with `git diff`).

5. **The gate.** All of these, in order; stop at the first failure and report it:

    ```bash
    pnpm run verify                                   # check + smoke
    pnpm e2e:tools                                    # the tool sandbox, end to end in Chromium
    pnpm --filter @aprscaching/web build
    node apps/web/test/visual/run.mjs --only tools,tools-decoder,rail-pinned
    ```

    `e2e:tools` and the visual run print `SKIP` without a Chromium (`CHROMIUM_PATH`, or
    `pnpm exec playwright-core install chromium`); a skip is reported to the user as a gap, never as a pass. Look at
    the screenshots in `apps/web/test/visual/out/` (`tools-*`, `tools-decoder-*`, `rail-pinned-*`) and say what they
    show.

6. **Pull request.**

    ```bash
    git add apps/web/public/tools
    git commit -s -m "chore(tools): bundle the tool registry $T"
    git -c url."https://github.com/".insteadOf="git@github.com:" push -u origin chore/bundle-tools-$T
    gh pr create -R apachler/aprscaching --base dev --head chore/bundle-tools-$T \
      --title "chore(tools): bundle the tool registry $T" \
      --body "<the release URL; tools added, removed and updated; the gate's results, skips included>"
    ```

    Report the PR URL and watch its checks (`gh pr checks <n> -R apachler/aprscaching --watch`). Do not merge.

7. **Clean up** the temporary worktrees: `git -C "$TOOLS" worktree remove "$S/aprscaching-tools-$T"`, and the
   bundle worktree once the user no longer needs it.
