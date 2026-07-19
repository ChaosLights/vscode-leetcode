// Copyright (c) jdneo. All rights reserved.
// Licensed under the MIT license.

import * as vscode from "vscode";
import * as cache from "./commands/cache";
import * as diagnose from "./commands/diagnose";
import { switchDefaultLanguage } from "./commands/language";
import * as plugin from "./commands/plugin";
import * as session from "./commands/session";
import * as show from "./commands/show";
import * as star from "./commands/star";
import * as submit from "./commands/submit";
import * as test from "./commands/test";
import { explorerNodeManager } from "./explorer/explorerNodeManager";
import { LeetCodeNode } from "./explorer/LeetCodeNode";
import { leetCodeTreeDataProvider } from "./explorer/LeetCodeTreeDataProvider";
import { leetCodeTreeItemDecorationProvider } from "./explorer/LeetCodeTreeItemDecorationProvider";
import { leetCodeChannel } from "./leetCodeChannel";
import { leetCodeExecutor } from "./leetCodeExecutor";
import { leetCodeManager } from "./leetCodeManager";
import { leetCodeStatusBarController } from "./statusbar/leetCodeStatusBarController";
import { DialogType, promptForOpenOutputChannel } from "./utils/uiUtils";
import { leetCodePreviewProvider } from "./webview/leetCodePreviewProvider";
import { leetCodeSolutionProvider } from "./webview/leetCodeSolutionProvider";
import { leetCodeSubmissionProvider } from "./webview/leetCodeSubmissionProvider";
import { markdownEngine } from "./webview/markdownEngine";
import { globalState } from "./globalState";
import { editorActionController } from "./editor/EditorActionController";
import { LiveShareCodeLensController } from "./codelens/LiveShareCodeLensController";
import { workspaceFileDeletionTracker } from "./utils/workspaceFileDeletionTracker";
import { ActivationCommandGate } from "./activation/ActivationCommandGate";
import { LiveSharePairingCoordinator } from "./pairing/liveSharePairingCoordinator";
import { pairingAuditLog } from "./pairing/pairingAuditLog";

let activePairingCoordinator: LiveSharePairingCoordinator | undefined;

function activateCompanionExtension(extensionId: string, displayName: string): void {
    const extension: vscode.Extension<unknown> | undefined = vscode.extensions.getExtension(extensionId);
    if (!extension) {
        leetCodeChannel.appendLine(
            `[startup] Optional companion ${displayName} (${extensionId}) is not installed in the local UI extension host.`,
        );
        return;
    }
    if (extension.isActive) {
        leetCodeChannel.appendLine(`[startup] Companion ${displayName} (${extensionId}) is already active.`);
        return;
    }

    // Excalidraw 3.9.3 only declares a workspaceContains activation event.
    // A local web/UI extension cannot discover files inside a Codespace or a
    // Live Share virtual workspace through that event, so its custom editor
    // and commands otherwise remain unregistered indefinitely.
    void extension.activate().then(
        () => leetCodeChannel.appendLine(`[startup] Activated companion ${displayName} (${extensionId}).`),
        (error: unknown) => {
            const message: string = error instanceof Error ? error.message : String(error);
            leetCodeChannel.appendLine(
                `[startup] Failed to activate companion ${displayName} (${extensionId}): ${message}`,
            );
        },
    );
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    if (process.env.VSCODE_LEETCODE_TEST_MODE === "1") {
        return;
    }
    pairingAuditLog.initialize(context);
    let codeLensController: LiveShareCodeLensController | undefined;
    const commandGate: ActivationCommandGate = new ActivationCommandGate();
    const pairingCoordinator: LiveSharePairingCoordinator = new LiveSharePairingCoordinator();
    activePairingCoordinator = pairingCoordinator;

    // Register every contributed command synchronously, before the first await.
    // Restored Remote/Live Share inlay hints can remain clickable while this
    // extension host is reconnecting. Their first click now waits for the same
    // activation instead of racing an as-yet-unregistered command.
    context.subscriptions.push(
        leetCodeChannel,
        pairingAuditLog,
        leetCodeExecutor,
        pairingCoordinator,
        vscode.window.registerUriHandler({
            handleUri: async (uri: vscode.Uri): Promise<void> => {
                if (/^\/pairing(?:\/|$)/i.test(uri.path)) {
                    try {
                        await pairingCoordinator.startFromUri(uri);
                    } catch (error) {
                        const message: string = error instanceof Error ? error.message : String(error);
                        leetCodeChannel.appendLine(`[pairing] Launcher URI rejected: ${message}`);
                        void vscode.window.showErrorMessage(`LeetCode Pairing failed: ${message}`);
                    }
                    return;
                }
                await leetCodeManager.handleUriSignIn(uri);
            },
        }),
        vscode.commands.registerCommand("leetcode.startPairing", () => pairingCoordinator.startFromCommand()),
        vscode.commands.registerCommand("leetcode.diagnosePairing", () => diagnose.diagnosePairing(context)),
        vscode.commands.registerCommand("leetcode.deleteCache", commandGate.wrap(() => cache.deleteCache())),
        vscode.commands.registerCommand("leetcode.toggleLeetCodeCn", commandGate.wrap(() => plugin.switchEndpoint())),
        vscode.commands.registerCommand("leetcode.signin", commandGate.wrap(() => leetCodeManager.signIn())),
        vscode.commands.registerCommand("leetcode.signout", commandGate.wrap(() => leetCodeManager.signOut())),
        vscode.commands.registerCommand("leetcode.manageSessions", commandGate.wrap(() => session.manageSessions())),
        vscode.commands.registerCommand(
            "leetcode.previewProblem",
            commandGate.wrap((node: LeetCodeNode | vscode.Uri) => show.previewProblem(node)),
        ),
        vscode.commands.registerCommand(
            "leetcode.showProblem",
            commandGate.wrap((node: LeetCodeNode) => show.showProblem(node)),
        ),
        vscode.commands.registerCommand("leetcode.pickOne", commandGate.wrap(() => show.pickOne())),
        vscode.commands.registerCommand("leetcode.searchProblem", commandGate.wrap(() => show.searchProblem())),
        vscode.commands.registerCommand(
            "leetcode.showSolution",
            commandGate.wrap((input: LeetCodeNode | vscode.Uri) => show.showSolution(input)),
        ),
        vscode.commands.registerCommand(
            "leetcode.refreshExplorer",
            commandGate.wrap(() => leetCodeTreeDataProvider.refresh()),
        ),
        vscode.commands.registerCommand(
            "leetcode.testSolution",
            commandGate.wrap((uri?: vscode.Uri) => test.testSolution(uri)),
        ),
        vscode.commands.registerCommand(
            "leetcode.submitSolution",
            commandGate.wrap((uri?: vscode.Uri) => submit.submitSolution(uri)),
        ),
        vscode.commands.registerCommand(
            "leetcode.switchDefaultLanguage",
            commandGate.wrap(() => switchDefaultLanguage()),
        ),
        vscode.commands.registerCommand(
            "leetcode.addFavorite",
            commandGate.wrap(async (node: LeetCodeNode) => {
                await star.addFavorite(node);
                codeLensController?.refresh();
            }),
        ),
        vscode.commands.registerCommand(
            "leetcode.removeFavorite",
            commandGate.wrap(async (node: LeetCodeNode) => {
                await star.removeFavorite(node);
                codeLensController?.refresh();
            }),
        ),
        vscode.commands.registerCommand(
            "leetcode.problems.sort",
            commandGate.wrap(() => plugin.switchSortingStrategy()),
        ),
        vscode.commands.registerCommand(
            "leetcode.showEditorActions",
            commandGate.wrap((uri?: vscode.Uri) => editorActionController.show(uri)),
        ),
    );
    activateCompanionExtension("pomdtr.excalidraw-editor", "Excalidraw");
    pairingCoordinator.initializeAutoHost();

    try {
        const workspaceSchemes: string[] = Array.from(new Set(
            (vscode.workspace.workspaceFolders || []).map((folder: vscode.WorkspaceFolder) => folder.uri.scheme),
        ));
        leetCodeChannel.appendLine(
            `[startup] version=${context.extension.packageJSON.version}, vscode=${vscode.version}, ` +
            `remote=${vscode.env.remoteName || "none"}, uiKind=${vscode.env.uiKind}, ` +
            `platform=${process.platform}, arch=${process.arch}, workspaceSchemes=${workspaceSchemes.join(",") || "none"}.`,
        );
        await globalState.initialize(context);
        await leetCodeExecutor.initialize(context);
        if (!(await leetCodeExecutor.meetRequirements())) {
            throw new Error("The environment doesn't meet requirements.");
        }

        leetCodeManager.on("statusChanged", () => {
            leetCodeStatusBarController.updateStatusBar(leetCodeManager.getStatus(), leetCodeManager.getUser());
            leetCodeTreeDataProvider.refresh();
        });

        leetCodeTreeDataProvider.initialize(context);
        context.subscriptions.push(
            leetCodeStatusBarController,
            leetCodePreviewProvider,
            leetCodeSubmissionProvider,
            leetCodeSolutionProvider,
            markdownEngine,
            editorActionController,
            workspaceFileDeletionTracker.start(),
            explorerNodeManager,
            vscode.window.registerFileDecorationProvider(leetCodeTreeItemDecorationProvider),
            vscode.window.createTreeView("leetCodeExplorer", { treeDataProvider: leetCodeTreeDataProvider, showCollapseAll: true }),
        );

        codeLensController = new LiveShareCodeLensController();
        context.subscriptions.push(
            codeLensController,
            leetCodeTreeDataProvider.onDidChangeTreeData(() => codeLensController?.refresh()),
        );

        await leetCodeExecutor.switchEndpoint(plugin.getLeetCodeEndpoint());
        await leetCodeManager.getLoginStatus();
        commandGate.succeed();
    } catch (error) {
        commandGate.fail();
        leetCodeChannel.appendLine(error.toString());
        promptForOpenOutputChannel("Extension initialization failed. Please open output channel for details.", DialogType.error);
    }
}

export async function deactivate(): Promise<void> {
    const pairingCoordinator: LiveSharePairingCoordinator | undefined = activePairingCoordinator;
    activePairingCoordinator = undefined;
    if (pairingCoordinator) {
        await pairingCoordinator.shutdown();
    }
}
