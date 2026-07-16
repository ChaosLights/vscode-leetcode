# Releasing the Live Share fork

1. Update `package.json`, `package-lock.json`, `CHANGELOG.md`, and the pinned links in the Live Share documentation.
2. Install exactly the locked dependencies with `npm ci`.
3. Run `npm run lint` and `npm run compile`.
4. Package with the pinned tool version:

   ```bash
   npx --yes @vscode/vsce@3.9.1 package --out vscode-leetcode-live-share-<version>.vsix
   sha256sum vscode-leetcode-live-share-<version>.vsix
   ```

5. Commit and push the source, tag the exact commit as `v<version>`, and create a GitHub Release containing the VSIX.
6. Download the release asset again and verify its SHA256 before updating any consuming repository.

The `publisher` and `name` fields intentionally remain `LeetCode.vscode-leetcode` because LeetCode's browser authorization callback targets that URI authority. The fork is distinguished by its higher version, display name, repository URL, release asset, and checksum.
