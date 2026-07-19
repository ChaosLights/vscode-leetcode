# Change Log

## 0.22.13

- Remove the Excalidraw companion from the pairing flow entirely: drop it from the extension pack, delete the reproducible companion VSIX packaging, and stop pinning it in the launcher lock. Excalidraw is a web-only extension, and an earlier release pinned it to `remote.extensionKind: ["ui"]` in global settings, which excludes the web worker host it needs and prevented it from running at all (blank editor, `command 'excalidraw.*' not found`). Shared drawings are handled outside the editor now.
- On startup, actively remove any stale `pomdtr.excalidraw-editor` entry from the global `remote.extensionKind` setting so machines affected by the earlier release self-heal.

## 0.22.12

- Replace the cross-extension Excalidraw activation workaround with a reproducibly patched Excalidraw 3.9.3 companion VSIX that declares its custom-editor and command activation events. This works across the local Node and web extension-host boundary used by Codespaces and Live Share.
- Declare every contributed LeetCode command as an explicit activation event so restored remote UI cannot encounter an unregistered command before `onStartupFinished`.
- Reject malformed and unrelated problem-tree decoration URIs instead of returning empty decorations that VS Code 1.119 reports as extension errors.

## 0.22.11

- Attempt to activate the pinned Excalidraw companion from the LeetCode extension host.

## 0.22.10

- Confirm that Live Share actually reaches the Guest role after `join()` returns; the pinned Live Share API can resolve the command before asynchronously rejecting an inactive invitation.
- Renew ready leases every 20 seconds and cap their effective lifetime at 75 seconds, including legacy leases that advertised a longer expiry, so a closed host cannot keep redirecting launchers to an ended session.
- Await host-lease release during extension deactivation and capture starting-host ownership before Live Share begins, preventing window close, extension upgrade, or reload from leaving a stale pairing lease.
- Add VS Code Extension Host regression coverage for delayed guest-role confirmation, inactive-session timeout, legacy-heartbeat expiry, and awaited shutdown release.

## 0.22.9

- Reuse one machine-managed election comment per GitHub user by updating it for each generation instead of appending a hidden-only comment on every launcher run.
- Elect from GitHub's server-side comment update time, validate that the comment author matches the candidate login, and retain deterministic comment-ID tie-breaking.
- Add a visible explanation to coordination comments and remove the same user's older duplicate candidate comments without allowing cosmetic cleanup failures to interrupt pairing.

## 0.22.8

- Write a persistent UTC JSONL pairing audit for every local extension host, covering election candidates and winners, lease state transitions, Codespace selection and connection, Live Share share/join results, heartbeats, stale-invite recovery, and errors without recording invitation URLs, cookies, tokens, or nonces.
- Prefix every LeetCode output-channel line with an ISO UTC timestamp and print the audit-log path at pairing startup.
- Persist the required UI extension placement globally before activating Live Share or connecting to a Codespace, and keep Live Share as an install pack instead of a pre-activated dependency, so local and remote extension hosts cannot collide while registering the same commands.
- Keep a waiting participant in the guest role when the elected host fails or an invitation expires; only that original host may rerun the launcher and recover the lease, preventing a second surprise Codespace.
- Add a timestamped Windows launcher transcript, a stable run ID shared with the VS Code URI, an always-visible terminal result, and a redacting one-click diagnostic collector for combining both computers' logs.

## 0.22.7

- Open the elected host through the installed GitHub Codespaces extension command instead of `gh codespace code`. The CLI only dispatches a `vscode://` URI and reports success before VS Code connects, which previously produced false-positive reopen attempts.
- Activate the local Codespaces extension explicitly, verify that VS Code has the same GitHub account as GitHub CLI, and launch its account sign-in or switch flow when needed.
- Stop after three unconfirmed connection attempts with an actionable error instead of leaving both participants on a 15-minute `starting` lease.
- Propagate Codespaces connection errors immediately and direct users to the GitHub Codespaces output channel for its connection log.

## 0.22.6

- Make first-time Codespace creation non-interactive by querying the current participant's available machine types, choosing the smallest Linux machine, and passing both the machine and default-permissions flags explicitly.
- Filter GitHub CLI informational billing lines from failures so the actual actionable error is reported instead of `Codespaces usage ... is paid for by ...`.
- Detect an ended Live Share invitation, clear it only when the ready lease has not changed since the failed join, and immediately restart host election instead of repeatedly opening an inactive session.
- Add regression coverage for machine selection, non-interactive creation arguments, and GitHub CLI error summarization.

## 0.22.5

- Recover when `gh codespace code` exits successfully without opening a VS Code remote window. While the elected host lease remains in `starting`, the host launcher now reissues the idempotent open request every 20 seconds until the Codespace publishes Live Share readiness.
- Let the same GitHub user recover a stuck active host lease by running the launcher again; guests continue to wait without attempting to open a Codespace they do not own.
- Add pure protocol coverage for retry ownership, matching Codespace identity, and lease expiry.
- Pin the GitHub Codespaces extension in the companion launcher so every potential first-opener has the required local remote resolver.

## 0.22.4

- Fix the first-time signed-out path in the Windows pairing launcher. GitHub CLI reports the expected “not logged in” probe on stderr; Windows PowerShell previously promoted it to a terminating `NativeCommandError` before the automatic browser login could start.
- Treat native stderr as process output while checking explicit exit codes, and keep interactive GitHub device codes and browser authorization prompts visible.
- Validate the fix with a regression test that simulates a completely signed-out GitHub CLI, completes a fake browser login, and reaches private-Issue preflight without any manual command.

## 0.22.3

- Let the Windows pairing launcher bootstrap GitHub CLI automatically. It prefers `winget` and falls back to the official portable GitHub CLI release with SHA-256 verification, so a first-time participant does not need to install `gh` manually.
- Open GitHub's browser authorization flow automatically when no account is signed in, and request missing `repo` and `codespace` scopes only when needed.
- Add an environment-only preflight mode for validating GitHub CLI, authentication, OAuth scopes, and private Issue access without opening VS Code or starting an election.

## 0.22.2

- Recover an elected host after Live Share has started but before its invitation was published. Retrieving an existing host link now omits the immutable access-level option instead of repeatedly failing with `Cannot change default access for an already shared session`.
- Work around a Live Share 1.1.122 regression where the public `share()` wrapper starts hosting but returns `null`: retrieve the current session invitation through the pinned extension's invitation command without copying through the clipboard or exposing the session identifier in logs.
- Fall back to Live Share's contributed Copy Invitation command when that internal return value is also discarded. The previous clipboard is restored immediately and a concurrent user copy is never overwritten.
- Close the host's now-unused blank launcher window after the Codespace becomes ready, and avoid refreshing the same ready lease on every 15-second discovery poll when its heartbeat is already active.
- Report only the scheme and authority when Live Share returns an unexpected invitation format, keeping the non-guessable session identifier out of logs while making current service-domain changes diagnosable.

## 0.22.1

- Negotiate the Live Share 1.1.122 public API through Microsoft's official `vsls` adapter. Live Share identifies callers from the adapter's `node_modules` path; a direct call from this extension's nested compiled file activated Live Share but resolved `package.json` from the wrong directory and returned a null API before host election began.
- Explicitly start a reusable `Shutdown` Codespace through GitHub's REST endpoint and wait until it reports `Available` before asking desktop VS Code to open it. `gh codespace code` can otherwise return successfully after only sending an open request, leaving an already-open disconnected window and the Codespace stopped.
- Keep the Codespace auto-host monitor alive across the local blank-window phase created by `gh codespace code`; the extension can activate before VS Code changes the window to a remote Codespace, when `vscode.env.remoteName` is still unset.
- Declare Live Share as a runtime extension dependency and report a precise host-placement error when an outdated Codespace setting runs Live Share remotely instead of beside the local LeetCode extension.
- Cover the real launcher upgrade path: the pinned VSIX installs locally, Live Share and Excalidraw versions remain exact, and the pairing URI reaches the new extension host.

## 0.22.0

- Add a local `LeetCode: Start or Join Pairing Session` flow backed by a private GitHub Issue. Simultaneous participants elect exactly one host from GitHub's monotonic comment IDs; the winner reuses or creates their own Codespace, while later participants wait and join automatically.
- Use Live Share's public extension API only for `share()` and `join()`. The pairing Issue contains no LeetCode cookie or GitHub token, accepts only known HTTPS Live Share invitation hosts, and uses short renewable leases so a crashed host cannot permanently block the session.
- Register the pairing URI and command before LeetCode CLI initialization, and monitor Codespace windows for host leases even when they were already open or their extension host restarted.
- Add strict repository/issue/branch validation, bounded GitHub CLI processes, cancellation, error redaction, host heartbeats, normal-session lease release, and unit coverage for election races, stale candidates, lease expiry, state serialization, and malicious invitation URLs.
- Include Live Share and Excalidraw as extension-pack companions; the repository launcher pins and repairs all three local extension versions before every pairing session.

## 0.21.6

- Register every clickable command synchronously before the first asynchronous activation step. A restored Codespaces or Live Share action can no longer race command registration and report `Actual command not found` on its first click.
- Gate early clicks on the in-progress activation: the first click now shows `Starting LeetCode...`, waits for initialization, and automatically executes exactly once without requiring a second click.
- Add a VS Code Extension Host regression that invokes a command before activation readiness, verifies it remains deferred, and proves both the deferred first click and later clicks execute once.

## 0.21.5

- Bind editor actions to the first generated code block instead of the last `@lc code=end`, so pasting a complete problem below the original cannot move the action strip to the duplicate.
- Refresh remote and Live Share inlay actions immediately on document changes and materialize an empty footer action line when edits remove it; actions no longer disappear temporarily or fall back to `code=endSubmit` at the source-line end.
- Add VS Code virtual-filesystem regressions that paste a duplicate generated block, remove it together with the final newline, and verify the original footer keeps a compact action strip on the following line throughout recovery.

## 0.21.4

- Move the Codespaces/Live Share local action strip to the empty line immediately below `@lc code=end`, matching CodeLens' compact separate-line presentation instead of appending controls to source text.
- Reduce action separators from double padding to the compact `Submit · Test · Solution · Description` layout and remove the extra leading padding.
- Register every clickable LeetCode command before exposing CodeLens or inlay providers, eliminating the restored-editor startup window that could report `Actual command not found` on the first click.
- Extend the VS Code 1.119 regression to assert the exact line, column, padding, label spacing, local command IDs, and guest document URI.

## 0.21.3

- Stop forwarding LeetCode CodeLens commands from Codespaces into Live Share. VS Code can preserve the lens range while losing a parameterized command between UI/Remote language-service hosts, which is rendered as the literal `no commands`.
- Keep native CodeLens for ordinary local files, and render one local clickable inline-action strip for `vscode-remote:` and `vsls:` documents. Submit, Test, Solution, Description, and optional Star now execute directly in the clicking window with its own document URI and account.
- Refresh remote/guest inline actions after editor switches, document opens, configuration changes, and bounded reconnect delays without registering a competing Live Share CodeLens provider or creating duplicate actions.
- Extend pairing diagnostics with effective CodeLens, inlay-hint, and Live Share command-control settings plus both provider result sets.
- Add VS Code 1.119 Extension Host regressions proving Remote/Live Share documents expose no remoted LeetCode CodeLens, exactly one four-action inline strip, local account commands, guest `vsls:` URIs, and repeatable clicks.

## 0.21.2

- Recover native CodeLens after a Codespaces connection restore by issuing two bounded provider refreshes for visible, valid `file:`, `untitled:`, and `vscode-remote:` LeetCode documents.
- Retry Live Share 1.1.122's exclusive guest CodeLens provider after transient co-editing/version synchronization failures. The recovery pulse uses a never-matching provider only to refresh VS Code's registry, so it cannot add a second set of guest actions.
- Scope `editor.codeLens` diagnostics to the active document and language, report every configuration level, and execute the active provider to distinguish disabled rendering, invalid markers, and an empty Live Share response without logging a path or credential.
- Add VS Code 1.119 Extension Host regressions for the `vscode-remote:` scheme, visible-editor provider refresh, recovery from a transient empty guest result, bounded retry, and single-set results.

## 0.21.1

- Recreate a generated problem file after a Live Share guest deletes it, even while Live Share still reports the deleted file through its stale metadata and read caches.
- Track deletion revisions from VS Code file operations and the `vsls:` file watcher so a later deletion cannot be cleared or reported as successful by an older Code Now request.
- Create every remote problem file through a unique staging file and an atomic, non-overwriting rename. Concurrent participants' files and unrelated staging files are always preserved.
- Wait for both the deleted target and the newly staged file to become visible, tolerate Live Share's ambiguous rename errors, verify the recreated target only after its new metadata is visible, and allow the wait to be cancelled.
- Release the per-problem Code Now lock after the file is open instead of waiting for information/error notifications or the optional description webview to close.
- Add Extension Host regressions for real deletion events, stale positive and negative caches, identical old/new templates, staging ownership, repeated deletion revisions, and a permanently pending information message.

## 0.21.0

- Restore native one-click CodeLens shortcuts for `Submit`, `Test`, `Solution`, `Description`, and optional `Star` inside generated solution files.
- Register the provider only for local/host `file:`, `untitled:`, and `vscode-remote:` documents. A Live Share guest's `vsls:` document receives the host set and does not add a duplicate local set.
- Route every lens through Live Share 1.1.122's explicitly guest-local `editor.action.showReferences` command. An empty result list produces only a local caret signal; the local bridge restores the prior selection and runs the action with that window's LeetCode account.
- Preserve the editor-title rocket, right-click menu, and command palette as fallbacks when editor CodeLens is disabled.
- Cache bounded solution metadata by document version so the provider does not scan unrelated large source files while scrolling.
- Extend pairing diagnostics with the current CodeLens visibility setting, and cover the host provider, single remoted guest set, local-account URI, repeated click, selection restoration, and invalid-marker cases in the VS Code integration suite.

## 0.20.0

- Replace the private Live Share extension API and custom host RPC with VS Code's `workspace.fs` virtual-file API. Current Live Share now performs the write through its registered `vsls:` provider, enforces the actual guest's read/write access, and no longer requires both sides to expose a custom service.
- Preserve an existing solution file when `Code Now` resolves to the same path, matching the upstream local-file behavior and preventing concurrent participants from erasing an answer.
- Verify every new remote file after creation, retry bounded Live Share propagation delays, reject read-only or disconnected guests with an actionable message, cap templates, and refuse writes through symbolic-link folders.
- Allow Test to read a selected `file:`, `vscode-remote:`, or `vsls:` test-case URI through `workspace.fs`; pass test cases as raw child-process arguments without obsolete shell quoting.
- Serialize duplicate Code Now/Test/Submit operations, make CLI progress cancellable, add three-minute and 25 MB process safety limits, and write real error stacks to the LeetCode output channel.
- Reuse the problem list obtained during login validation and serialize Explorer refreshes, removing the duplicated full problem-list request seen after login.
- Isolate the legacy CLI session under this extension's VS Code global storage instead of sharing or deleting `~/.lc`; fix endpoint cleanup ordering and require Node.js 20 or newer.
- Remove all telemetry, including username and workspace-path reporting.
- Add `LeetCode: Diagnose Pairing`, available even when the Node.js/CLI requirement check fails, with credential-free host, version, trust, and workspace-writability diagnostics.
- Sanitize LeetCode description HTML, use a nonce-based script policy, disable command URIs, constrain credential-bearing Axios requests to HTTPS LeetCode hosts, and add an expiring one-shot web-login callback gate.
- Upgrade direct dependencies and compatible legacy CLI transitive dependencies. `npm audit` now has no high or critical findings; the deprecated CLI `request`/`uuid` chain leaves three moderate advisories with no upstream fix.
- Run unit, external CLI, and VS Code virtual-filesystem integration tests on both Windows and Linux CI.

## 0.19.13

- Finish the `Fetching user data...` progress as soon as login validation and state persistence complete.
- Show the successful-login notification only after the progress operation has closed, without waiting for the notification to be dismissed.

## 0.19.12

- Complete interactive Cookie login as soon as the legacy CLI prints its success marker, close the prompt's stdin, and prevent a valid login from being misreported as a timeout.
- Add regression coverage ensuring the terminal success marker takes precedence over the cumulative `login:` and `cookie:` prompts.

## 0.19.11

- Restore the official extension's external `node` child-process runtime for every bundled CLI command; remove the `Code.exe` and Electron Worker execution paths introduced after v0.19.2.
- Restore the official interactive `leetcode user -c` Cookie login so the CLI owns its complete session record, while retaining SecretStorage verification, automatic repair, cache isolation, and end-to-end problem-list validation.
- Keep all Local/UI, Live Share RPC, per-account workspace routing, editor actions, temporary-file isolation, Explorer, Test, Submit, Solution, and Description behavior unchanged.
- Add an external-process regression test covering CLI help, session discovery, cache deletion, and a 6000-problem output.

## 0.19.10

- Start and advance the legacy CLI problem-category queue directly instead of relying on its obsolete `setImmediate` scheduling inside an Electron worker.
- Add cookie-safe list diagnostics for the problem cache and each category request so an empty result can no longer hide which stage stopped.

## 0.19.9

- Wait for the CLI worker's stdout and stderr streams to finish draining before accepting its exit result, preventing large problem lists from becoming an empty result on Windows.
- Add a regression test that captures and verifies a problem list larger than the worker pipe buffer.

## 0.19.8

- Run the bundled CLI in a Node.js `worker_threads` worker inside the local VS Code extension host instead of launching `Code.exe` as a Node executable.
- Replace the misleading `node -p` requirement probe with a real bundled `leetcode --help` script execution and output check.
- Keep external Node and WSL execution only for users who explicitly configure those modes.
- Add worker start, exit-code, and output-size diagnostics, with custom test input redacted.
- Add an integration test that executes the compiled CLI worker under Node.js 24 and verifies both CLI help and a directly written user session.

## 0.19.7

- Bypass the legacy interactive cookie-login command on desktop and write the already verified cookie fields directly to the CLI's own local session format.
- Validate every rebuilt session end to end by running a non-interactive problem list before marking the user as signed in.
- Add cookie-safe login diagnostics for endpoint, session-file path and size, token lengths, runtime selection, CLI output size, and parsed problem count.
- Preserve or retrieve the Favorite list hash used by star/unstar without logging or duplicating the full cookie in the CLI session file.

## 0.19.6

- Accept a verified cookie when the legacy CLI consumes both prompts and exits successfully but omits its optional success text under Node.js 24.
- Include non-secret prompt-state diagnostics if the CLI exits before consuming the cookie.

## 0.19.5

- Verify the securely stored cookie before restoring login instead of trusting a stale local CLI user record.
- Clear account-specific problem caches when migrating or changing accounts, then automatically rebuild and retry a failed problem load once.
- Persist login state only after the bundled CLI accepts the cookie, preventing half-signed-in Explorer state.
- Detect an empty or unparseable problem list and return to the signed-out view instead of silently showing empty category folders.
- Buffer interactive CLI prompts so split output chunks cannot stall cookie login, and suppress obsolete dependency warnings from the bundled CLI.

## 0.19.4

- Add `leetcode.workspaceFolderByUser` so one checked-in workspace configuration can route each locally signed-in LeetCode account to a different shared folder.
- Honor `leetcode.workspaceFolder` for Remote/Codespaces and Live Share when the configured destination stays inside the shared workspace.
- Allow workspace configuration of `leetcode.workspaceFolder` and `leetcode.nodePath` through appropriate VS Code configuration scopes.
- Stop passing the removed `--ms-enable-electron-run-as-node` compatibility flag to VS Code 1.127 and newer.
- Fail explicitly when a signed-in username has no configured folder instead of writing to the remote workspace root.

## 0.19.3

- Run the bundled LeetCode CLI with VS Code's built-in Node.js runtime by default.
- Remove the desktop requirement to install Node.js or add `node` to `PATH`.
- Keep full-path external Node.js and WSL Node.js overrides available through `leetcode.nodePath` and `leetcode.useWsl`.
- Route interactive login and favorite commands through the same runtime instead of hard-coding `node`.

## 0.19.2

- Write Live Share problem templates without a size limit or per-file confirmation.
- Replace existing problem files when `Show Problem` resolves to the same path.
- Keep problem-file writes confined to the selected workspace folder.

## 0.19.1

- Automatically accept validated problem-file requests from read/write Live Share guests by default.
- Add `leetcode.liveShare.autoApproveProblemFiles` so a host can restore per-file confirmation when desired.

## 0.19.0

- Run the account-bound extension in each participant's local UI extension host.
- Support isolated local LeetCode accounts for Remote/Codespaces and Live Share documents.
- Create Explorer problem files through remote URI-aware `workspace.fs` APIs, with an approved host-side RPC for Live Share guests.
- Replace remoted CodeLens with a local editor action menu to eliminate duplicate or host-bound commands.
- Persist cookies in VS Code SecretStorage and add a verified NeetCode 150 Explorer category.
All notable changes to the "leetcode" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.18.4]
### Added
- change graphql path

## [0.18.3]
### Added
- re-add cookie-based login method  [PR#969](https://github.com/LeetCode-OpenSource/vscode-leetcode/pull/969)

## [0.18.2]
### Fixed
- fix login issue on VS Code Insiders  [PR#968](https://github.com/LeetCode-OpenSource/vscode-leetcode/pull/968)

## [0.18.1]
### Changed
- change login way and add tracking logic option [PR#944](https://github.com/LeetCode-OpenSource/vscode-leetcode/pull/944)

## [0.18.0]
### Added
- Add `star` command in shortcuts [PR#601](https://github.com/LeetCode-OpenSource/vscode-leetcode/pull/601)
- Add an option to disable endpoint translation [#389](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/389)

### Changed
- LeetCode actions are moved into sub-menu: `LeetCode` in the editor context menu. [PR#712](https://github.com/LeetCode-OpenSource/vscode-leetcode/pull/712)

### Fixed
[Bugs fixed](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues?q=is%3Aissue+milestone%3A0.18.0+is%3Aclosed+label%3Abug)

## [0.17.0]
### Added
- Add TypeScript support [#560](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/560)

### Changed
- Update the UI resources [PR#561](https://github.com/LeetCode-OpenSource/vscode-leetcode/pull/561)

## [0.16.2]
### Added
- New Category: `Concurrency` [CLI#42](https://github.com/leetcode-tools/leetcode-cli/pull/42)
- New configuration to better configure how to show the description [#310](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/310)

### Removed
- Removed the deprecated setting `leetcode.enableShortcuts` [PR#520](https://github.com/LeetCode-OpenSource/vscode-leetcode/pull/520)
- Removed the deprecated setting `leetcode.outputFolder` [PR#521](https://github.com/LeetCode-OpenSource/vscode-leetcode/pull/521)

## [0.16.1]
### Added
- Can show the problem in current workspace even if it's not a LeetCode workspace [#373](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/373)

### Fixed
[Bugs fixed](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues?q=is%3Aissue+milestone%3A0.16.1+is%3Aclosed+label%3Abug)

## [0.16.0]
### Added
- Support GitHub login and LinkedIn login [PR#496](https://github.com/LeetCode-OpenSource/vscode-leetcode/pull/496)

## [0.15.8]
### Added
- Add a new command `Sign In by Cookie` to workaround the issue that [users cannot login to LeetCode](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/478). Please check the [workaround steps](https://github.com/LeetCode-OpenSource/vscode-leetcode/tree/master#%EF%B8%8F-attention-%EF%B8%8F--workaround-to-login-to-leetcode-endpoint) for more details!

### Changed
- Update the explorer icons to be align with the VS Code design [#460](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/460)

## [0.15.7]
### Fixed
[Bugs fixed](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues?q=is%3Aissue+milestone%3A0.15.7+is%3Aclosed+label%3Abug)

## [0.15.6]
### Added
- Add a link to the solution page [#424](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/424)

### Fixed
[Bugs fixed](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues?q=is%3Aissue+milestone%3A0.15.6+is%3Aclosed+label%3Abug)

## [0.15.5]
### Added
- Add a link to the discussion page [#420](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/420)

### Fixed
[Bugs fixed](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues?q=is%3Aissue+milestone%3A0.15.5+is%3Aclosed+label%3Abug)

## [0.15.4]
### Added
- Add a new setting `leetcode.filePath`. Now users can use this setting to dynamicly specify the relative folder name and file name. [#PR380](https://github.com/LeetCode-OpenSource/vscode-leetcode/pull/380)

### Fixed
- Missing language `Rust` in the supported language list. [#PR412](https://github.com/LeetCode-OpenSource/vscode-leetcode/pull/412)
- Cannot show output when the answer is wrong. [#414](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/414)

## [0.15.3]
### Added
- Support `Pick One` [#263](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/263)
- Support toggling the favorite problems [#378](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/378)

### Changed
- Update the activity bar icon [#395](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/263)

### Fixed
[Bugs fixed](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues?q=is%3Aissue+milestone%3A0.15.3+is%3Aclosed+label%3Abug)

## [0.15.2]
### Added
- Prompt to open the workspace for LeetCode [#130](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/130)
- Support deleting sessions [#198](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/130)

### Fixed
[Bugs fixed](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues?q=is%3Aissue+milestone%3A0.15.2+is%3Aclosed+label%3Abug)

## [0.15.1]
### Fixed
[Bugs fixed](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues?q=is%3Aissue+milestone%3A0.15.1+is%3Aclosed+label%3Abug)

## [0.15.0]
### Added
- Auto refresh the explorer after submitting [#91](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/91)
- Add a editor shortcut `Description` to show the problem description [#286](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/286)
- Support customizing the shortcuts in editor [#335](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/335)

### Fixed
[Bugs fixed](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues?q=is%3Aissue+milestone%3A0.15.0+is%3Aclosed+label%3Abug)

## [0.14.3]
### Added
- Support interpolation for `leetcode.outputFolder` settings [#151](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/151)

### Fixed
[Bugs fixed](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues?q=is%3Aissue+is%3Aclosed+milestone%3A0.14.3+label%3Abug)

## [0.14.2]
### Added
- Add the `All` category in the LeetCode Explorer [#184](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/184)
- Add shortcuts for `Show top voted solution` [#269](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/269)

### Fixed
[Bugs fixed](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues?q=is%3Aissue+is%3Aclosed+label%3Abug+milestone%3A0.14.2)

## [0.14.1]
### Added
- Add setting `leetcode.showCommentDescription` to specify whether including the problem description in comments or not [#287](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/287)

## [0.14.0]
### Added
- Add setting `leetcode.enableShortcuts` to specify whether to show the submit/test shortcuts in editor [#146](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/146)
- Add `Like` and `Dislike` counts in the problem description [#267](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/267)

### Changed
- Improve the `Preview`, `Result` and `Solution` views

### Fixed
[Bugs fixed](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues?q=is%3Aissue+label%3Abug+is%3Aclosed+milestone%3A0.14.0)

## [0.13.3]
### Fixed
- Fix the bug that the extension cannot be activated

## [0.13.2]
### Added
- Add a setting `leetcode.enableStatusBar` to specify whether the LeetCode status bar will be shown or not [#156](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/156)
- Add a setting `leetcode.nodePath` to specify the `Node.js` executable path [#227](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/227)

### Changed
- Update the activity bar icon, See: [#225](https://github.com/LeetCode-OpenSource/vscode-leetcode/pull/225)

### Fixed
[Bugs fixed](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues?q=is%3Aissue+milestone%3A0.13.2+is%3Aclosed+label%3Abug)

## [0.13.1]
### Fixed
[Bugs fixed](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues?q=is%3Aissue+milestone%3A0.13.1+is%3Aclosed+label%3Abug)

## [0.13.0]
### Added
- Preview the problem description [#131](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/131)
- Show top voted solution [#193](https://github.com/LeetCode-OpenSource/vscode-leetcode/pull/193)
- Add `collapse all` for the explorer [#197](https://github.com/LeetCode-OpenSource/vscode-leetcode/pull/197)

### Fixed
[Bugs fixed](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues?q=is%3Aissue+is%3Aclosed+milestone%3A0.13.0+label%3Abug)

## [0.12.0]
### Added
- Add new command `LeetCode: Switch Default Language` to support switching the default language [#115](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/115)
- Support `PHP` and `Rust` ([#83](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/83), [#103](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/103))

### Fixed
- Cannot retrieve time and memory result [#105](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/105)
- Power operator displays in a wrong way [#74](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/74)

## [0.11.0]
### Added
- Add new setting: `leetcode.outputFolder` to customize the sub-directory to save the files generated by 'Show Problem' [#119](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/119)
- Add tooltips for sub-category nodes in LeetCode Explorer [#143](https://github.com/LeetCode-OpenSource/vscode-leetcode/pull/143)

### Changed
- Now when triggering 'Show Problem', the extension will not generate a new file if it already exists [#59](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/59)

### Fixed
- Log in timeout when proxy is enabled [#117](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/117)

## [0.10.2]
### Fixed
- Test cases cannot have double quotes [#60](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/60)

## [0.10.1]
### Changed
- Refine the README page.

## [0.10.0]
### Added
- Add an extension setting to hide solved problems [#95](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/95)
- Support categorize problems by company, tag, difficulty and favorite [#67](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/67)

## [0.9.0]
### Changed
- Improve the experience of switching endpoint [#85](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/85)
- Use web view to show the result page [#76](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/76)


## [0.8.2]
### Added
- Add Code Lens for submitting the answer to LeetCode

### Fixed
- Fix the bug that the extension could not automatically sign in [#72](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/72)

## [0.8.1]
### Changed
- Upgrade LeetCode CLI to v2.6.1

## [0.8.0]
### Added
- Support LeetCode CN [#50](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/50)
- Support Windows Subsystem for Linux [#47](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/47)

## [0.7.0]
### Added
- Add spinner when submitting code [#43](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/43)

## [0.6.1]
### Added
- Add Sign in action into LeetCode Explorer title area [#25](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/25)

## [0.6.0]
### Changed
- Move LeetCode explorer into activity bar [#39](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/39)

### Added
- Support trigger test & submit in the editor [#37](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/37)

### Fixed
- Fix the bug that cannot show problem [#41](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/41)

## [0.5.1]
### Fixed
- Fix the bug when user's path contains white spaces [#34](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/34)

## [0.5.0]
### Added
- Support submit and test solution files from the file explorer in VS Code ([#24](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/24), [#26](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/26))

## [0.4.0]
### Added
- Support locked problem [#20](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/20)

### Changed
- Simplify the command 'LeetCode: Test Current File' to 'LeetCode: Test' [#18](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/18)
- Will automatically save current file when 'LeetCode: Test' command is triggered [#17](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/17)

## [0.3.0]
### Added
- Test current solution file [#15](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/15)

## [0.2.1]
### Fixed
- Fix the wrong icon bug in LeetCode Explorer [#9](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/9)
- Fix the switch session bug when login session is expired [#12](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/12)

## [0.2.0]
### Added
- Support setting the default language to solve problems [#5](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/5)

### Fixed
- When user cancels login, no further actions will happen [#10](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/10)

## [0.1.2]
### Fixed
- Fix the duplicated nodes in LeetCode Explorer bug [#6](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/6)

## [0.1.1]
### Fixed
- Fix a bug in LeetCode Explorer [#3](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/3)
- Remove the show problem command from command palette [#4](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/4)

## [0.1.0]
### Added
- Sign in/out to LeetCode
- Switch and create session
- Show problems in explorer
- Search problems by keywords
- Submit solutions to LeetCode
