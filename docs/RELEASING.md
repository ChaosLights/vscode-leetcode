# Releasing the Live Share fork

1. Update `package.json`, `package-lock.json`, `CHANGELOG.md`, and the pinned links in the Live Share documentation.
2. Install exactly the locked dependencies with `npm ci`.
3. Run `npm run lint`, `npm test`, and `npm run test:vscode`. The VS Code integration suite must pass the virtual-workspace create, propagation, no-overwrite, symlink, and read-only cases.
4. Run `npm audit --audit-level=high`. A release must have no high or critical findings; document any unfixable lower-severity advisory inherited from the legacy CLI.
5. Package with the pinned tool version:

   ```bash
   npx --yes @vscode/vsce@3.9.1 package --out vscode-leetcode-live-share-<version>.vsix
   sha256sum vscode-leetcode-live-share-<version>.vsix
   ```

6. Install the packaged VSIX into an isolated desktop VS Code profile and confirm the extension activates locally.
7. Commit and push the source, tag the exact commit as `v<version>`, and create a GitHub Release containing the VSIX.
8. Download the release asset again and verify its SHA256 before updating any consuming repository.

The `publisher` and `name` fields intentionally remain `LeetCode.vscode-leetcode` because LeetCode's browser authorization callback targets that URI authority. The fork is distinguished by its higher version, display name, repository URL, release asset, and checksum.
