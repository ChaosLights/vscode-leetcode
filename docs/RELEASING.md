# Releasing the Live Share fork

1. Update `package.json`, `package-lock.json`, `CHANGELOG.md`, and the pinned links in the Live Share documentation.
2. Install exactly the locked dependencies with `npm ci`.
3. Run `npm run lint`, `npm test`, and `npm run test:vscode`. The VS Code integration suite must pass local CodeLens, Remote/Live Share local actions (including authoritative-footer selection, footer-line recreation, layout, synchronous command registration, and deferred first-click readiness), deletion-event recreation, stale-cache propagation, no-overwrite/staging ownership, symlink, and read-only cases.
4. Run `npm audit --audit-level=high`. A release must have no high or critical findings; document any unfixable lower-severity advisory inherited from the legacy CLI.
5. Package the LeetCode extension with the pinned tools:

   ```bash
   npm run build
   sha256sum vscode-leetcode-live-share-<version>.vsix
   ```

6. Install the packaged VSIX into an isolated desktop VS Code profile and confirm the extension activates locally.
7. With Live Share 1.1.122, open the same generated problem on a Codespaces host and guest. Confirm each window shows one inline-action strip, no `no commands` CodeLens, and that Test/Submit use different local accounts.
8. Commit and push the source, merge only after Windows/Linux CI passes, and build again from the clean merge commit.
9. Prepare the consuming repository's final lock file and companion launcher ZIP before publishing. The ZIP must contain its fixed file set at the archive root, including the exact lock that names this VSIX and SHA256.
10. Create an annotated `v<version>` tag on the verified merge commit, then create a draft GitHub Release and upload the final VSIX and launcher ZIP exactly once.
11. Download both draft assets into a new directory and verify their SHA256 values and archive contents before publishing the draft.
12. Treat every published tag and asset as immutable: never force a tag, use `--clobber`, delete an asset, or replace a same-version file. Publish the next patch version for every correction.
13. Merge the consuming repository's lock update only after the public assets have been downloaded and verified, so its default branch never points at a missing release.

The `publisher` and `name` fields intentionally remain `LeetCode.vscode-leetcode` because LeetCode's browser authorization callback targets that URI authority. The fork is distinguished by its higher version, display name, repository URL, release asset, and checksum.
