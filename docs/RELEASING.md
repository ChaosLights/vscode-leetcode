# Releasing the Live Share fork

1. Update `package.json`, `package-lock.json`, `CHANGELOG.md`, and the pinned links in the Live Share documentation.
2. Install exactly the locked dependencies with `npm ci`.
3. Run `npm run lint`, `npm test`, and `npm run test:vscode`. The VS Code integration suite must pass local CodeLens, Remote/Live Share local actions (including footer-relative layout and command readiness), deletion-event recreation, stale-cache propagation, no-overwrite/staging ownership, symlink, and read-only cases.
4. Run `npm audit --audit-level=high`. A release must have no high or critical findings; document any unfixable lower-severity advisory inherited from the legacy CLI.
5. Package with the pinned tool version:

   ```bash
   npm run build
   sha256sum vscode-leetcode-live-share-<version>.vsix
   ```

6. Install the packaged VSIX into an isolated desktop VS Code profile and confirm the extension activates locally.
7. With Live Share 1.1.122, open the same generated problem on a Codespaces host and guest. Confirm each window shows one inline-action strip, no `no commands` CodeLens, and that Test/Submit use different local accounts.
8. Commit and push the source, tag the exact commit as `v<version>`, and create a GitHub Release containing the VSIX.
9. Download the release asset again and verify its SHA256 before updating any consuming repository.

The `publisher` and `name` fields intentionally remain `LeetCode.vscode-leetcode` because LeetCode's browser authorization callback targets that URI authority. The fork is distinguished by its higher version, display name, repository URL, release asset, and checksum.
