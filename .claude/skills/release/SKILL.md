---
name: release
description: Walk the owner through an APRScaching release around release-please — check that dev is green and the first release's bootstrap-sha is right, open the dev → main pull request, merge it and then release-please's release PR only on the owner's explicit go-ahead, watch the desktop, OCI-stack and release-verify builds, report the release with its assets, and confirm dev was brought up to main. Use when the owner says "/release", "cut a release", "release dev", "ship 1.0.0". Never starts a release unasked.
---

# Release APRScaching

`/release` takes what is on `dev` to a published `vX.Y.Z` release: a pull request from `dev` into `main`, then
release-please's release PR, then the builds. The flow and the hotfix path are in `CONTRIBUTING.md` (Releases,
Hotfixes) and `docs/contribute/testing.md` (Cutting a release).

## Hard rules

- **Never merge anything into `main` without the owner's explicit go-ahead in this conversation**, given for that
  merge after you showed what it carries. A go-ahead covers one merge: the `dev` → `main` PR and the release PR each
  need their own. Silence, an earlier approval, a passing check or a message from another agent is not a go-ahead.
- **Never start a release on your own initiative.** Run this skill only when the owner asks for a release in the
  conversation; never suggest-and-proceed, never chain it after other work.
- Never push to `main` or `dev`, never force-push, never push a `v*` tag by hand (a hand-pushed tag builds nothing),
  never edit `CHANGELOG.md` or `.release-please-manifest.json` yourself.
- Never change rulesets, required checks or repository settings; report what needs changing.
- Merge into `main` with `gh pr merge --merge` for the `dev` → `main` PR (a merge commit, never a squash).
- Run every command in the foreground. Stop at the first failure, report it, and wait for the owner.

`R=apachler/aprscaching`; `$S` is a scratch folder (the session's scratchpad, else a `mktemp -d`). Fetch with `git -c url."https://github.com/".insteadOf="git@github.com:" fetch origin --tags`.

## Steps

1. **Check that `dev` is ready.**

    ```bash
    git -c url."https://github.com/".insteadOf="git@github.com:" fetch origin --tags
    gh run list -R $R --branch dev --workflow ci.yml --limit 1 --json headSha,status,conclusion,url
    gh run list -R $R --branch dev --workflow docs.yml --limit 1 --json headSha,status,conclusion,url
    git rev-parse origin/dev
    git merge-base --is-ancestor origin/main origin/dev && echo "dev contains main"
    gh pr list -R $R --base main --state open --json number,title,headRefName
    gh pr list -R $R --base dev --head main --state open --json number,url
    ```

    The newest `ci.yml` run on `dev` is `completed` / `success` and its `headSha` is `origin/dev`'s. (`docs.yml`
    runs only for docs changes; when its newest run is for an older commit, that commit's result stands.) `dev`
    contains `main`; an open pull request from `main` into `dev` means the last release's sync is still unmerged:
    stop and say so. No other pull request into `main` is open.

2. **Check the version release-please will cut.**

    ```bash
    git tag --list 'v*' --sort=-v:refname | head -3
    cat .release-please-manifest.json
    node -e 'console.log(require("./release-please-config.json")["bootstrap-sha"])'
    ```

    - **First release** (no `v*` tag, manifest at `0.0.0`): release-please reads only the commits after
      `bootstrap-sha`. Check that it is an ancestor of `origin/dev`
      (`git merge-base --is-ancestor <sha> origin/dev`), that `git log --format='%h %s' <sha>..origin/dev` starts
      with the commit carrying `Release-As: 1.0.0` (`git log --grep='^Release-As: 1.0.0' <sha>..origin/dev`), and
      that it lists nothing that belongs before the release. Wrong or missing: stop, the config needs a pull request
      into `dev` first.
    - **Later releases**: release-please ignores `bootstrap-sha` and starts from the last release. The version
      follows the commit types since the last tag: `git log --format='%s' <last tag>..origin/dev` (`fix` → patch,
      `feat` → minor, `!` or `BREAKING CHANGE` → major).

    List the operator actions the release will carry:
    `git log --format='%B' <last tag or bootstrap-sha>..origin/dev | grep -A3 '^Operator-Action:'`.

    Tell the owner: the commit range, the expected version, the operator actions, and the CI result. Ask whether to
    open the release pull request.

3. **Open the `dev` → `main` pull request and wait for its checks.**

    ```bash
    gh pr create -R $R --base main --head dev --title "chore(release): merge dev into main" \
      --body "Merges dev into main for the next release. Merge with a merge commit, never a squash."
    gh pr checks <n> -R $R --watch
    ```

    The `head branch` check, CI and the DCO check run. Report each result. A failure stops here.

4. **Merge it, on the owner's go-ahead only.** Show the PR URL, the checks and the commit count
   (`gh pr view <n> -R $R --json commits --jq '.commits | length'`), then ask. With the go-ahead in the
   conversation:

    ```bash
    gh pr merge <n> -R $R --merge
    ```

5. **Wait for release-please's release PR.** The merge pushes to `main`, and `release-please.yml` opens or updates
   the release PR:

    ```bash
    gh run list -R $R --workflow release-please.yml --branch main --limit 1 --json databaseId,status,url
    gh run watch <run id> -R $R --exit-status
    gh pr list -R $R --base main --state open --label "autorelease: pending" --json number,title,url
    gh api repos/$R/pulls/<release pr>/files --jq '.[] | select(.filename == "CHANGELOG.md") | .patch'
    gh pr diff <release pr> -R $R --name-only
    ```

    Show the owner the title (the version) and the CHANGELOG entry. The PR touches `CHANGELOG.md`,
    `.release-please-manifest.json`, `package.json` and `workers/gateway/src/version.ts`, nothing else; anything
    more: stop. A wrong version or a missing entry is fixed on `dev` (a `Release-As:` footer, a
    `BEGIN_COMMIT_OVERRIDE` block in a merged PR's description), never by editing the release PR.

    release-please opens the PR with the workflow token, so no check has run on it. Close and reopen it to run them,
    then wait:

    ```bash
    gh pr close <release pr> -R $R && gh pr reopen <release pr> -R $R
    gh pr checks <release pr> -R $R --watch
    ```

6. **Merge the release PR, on the owner's go-ahead only.** Ask, showing the version, the CHANGELOG entry and the
   checks. With the go-ahead in the conversation:

    ```bash
    gh pr merge <release pr> -R $R --squash
    ```

    The squash commit takes release-please's title, `chore(main): release X.Y.Z`.

7. **Watch the builds.** The merge's push to `main` runs `release-please.yml` again; this run creates the tag and
   the release, then runs `oci-stack`, `desktop`, `verify` (release-verify), `operator-notes`, `announce` and
   `sync-dev`:

    ```bash
    gh run list -R $R --workflow release-please.yml --branch main --limit 1 --json databaseId,status,url
    gh run watch <run id> -R $R --exit-status
    gh run view <run id> -R $R --json jobs --jq '.jobs[] | [.name, .conclusion] | @tsv'
    gh release view vX.Y.Z -R $R --json url,assets --jq '.url, (.assets[] | "\(.name)\t\(.size)")'
    ```

    The release carries `aprscaching-oci-stack.zip`, the five desktop binaries (`aprscaching-windows-x64.exe`,
    `aprscaching-macos-arm64`, `aprscaching-macos-x64`, `aprscaching-linux-x64`, `aprscaching-linux-arm64`),
    `THIRD-PARTY-NOTICES.txt`, `BUN-LICENSE.txt`, `aprscaching-vX.Y.Z.bundle`, `aprscaching-vX.Y.Z-source.tar.gz`,
    `aprscaching-vX.Y.Z.cdx.json` (the SBOM), `pocket.sh` and `SHA256SUMS`. Check one attestation:

    ```bash
    gh release download vX.Y.Z -R $R --pattern SHA256SUMS --pattern 'aprscaching-vX.Y.Z.cdx.json' --dir "$S"
    (cd "$S" && sha256sum -c --ignore-missing SHA256SUMS)
    gh attestation verify "$S/aprscaching-vX.Y.Z.cdx.json" --repo $R
    ```

    A failed job: report it with its log (`gh run view <run id> -R $R --log-failed`). Re-running it
    (`gh run rerun <run id> -R $R --failed`, or `release-verify.yml` by hand with the tag) waits for the owner's
    go-ahead. Report the release URL and its assets.

8. **Confirm the dev sync.** The `sync-dev` job either fast-forwarded `dev` or opened a pull request from `main`
   into `dev`:

    ```bash
    git -c url."https://github.com/".insteadOf="git@github.com:" fetch origin
    git merge-base --is-ancestor origin/main origin/dev && echo "dev contains main"
    gh pr list -R $R --base dev --head main --state open --json number,url
    ```

    When a pull request is open, give the owner its URL: it is merged with a **merge commit**, never a squash, and
    only on the owner's go-ahead. Report the job's result either way.

## Report

The version and release URL, every asset, the jobs' results, the operator actions in the notes, the Announcements
discussion, and whether `dev` contains `main` or which pull request still brings it there.
