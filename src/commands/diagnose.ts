// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

import * as vscode from "vscode";
import { leetCodeChannel } from "../leetCodeChannel";
import { leetCodeExecutor } from "../leetCodeExecutor";

const liveShareExtensionId: string = "ms-vsliveshare.vsliveshare";

export async function diagnosePairing(context: vscode.ExtensionContext): Promise<void> {
    const extensionKind: string = context.extension.extensionKind === vscode.ExtensionKind.UI ? "ui" : "workspace";
    const liveShareExtension: vscode.Extension<any> | undefined =
        vscode.extensions.getExtension(liveShareExtensionId);
    const workspaceFileSystems: string[] = (vscode.workspace.workspaceFolders || []).map(
        (folder: vscode.WorkspaceFolder): string => {
            const writable: boolean | undefined = vscode.workspace.fs.isWritableFileSystem(folder.uri.scheme);
            return `${folder.uri.scheme}:${writable === undefined ? "unknown" : writable ? "writable" : "read-only"}`;
        },
    );
    const editorConfiguration: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("editor");
    const codeLensEnabled: boolean = editorConfiguration.get<boolean>("codeLens", true);

    leetCodeChannel.appendLine("[diagnostics] ---- LeetCode pairing diagnostics ----");
    leetCodeChannel.appendLine(
        `[diagnostics] extension=${context.extension.packageJSON.version}, kind=${extensionKind}, ` +
        `vscode=${vscode.version}, uiKind=${vscode.env.uiKind}, remote=${vscode.env.remoteName || "none"}.`,
    );
    leetCodeChannel.appendLine(
        `[diagnostics] platform=${process.platform}, arch=${process.arch}, trusted=${vscode.workspace.isTrusted}.`,
    );
    leetCodeChannel.appendLine(
        `[diagnostics] workspaces=${workspaceFileSystems.join(",") || "none"}.`,
    );
    leetCodeChannel.appendLine(
        `[diagnostics] liveShare=${liveShareExtension?.packageJSON.version || "not-installed"}, ` +
        `active=${liveShareExtension?.isActive || false}.`,
    );
    leetCodeChannel.appendLine(
        `[diagnostics] codeLens=${codeLensEnabled}.`,
    );
    try {
        leetCodeChannel.appendLine(`[diagnostics] ${await leetCodeExecutor.getRuntimeDescription()}.`);
    } catch (error) {
        leetCodeChannel.appendLine("[diagnostics] node=unavailable; check leetcode.nodePath and Node.js 20+.");
    }
    leetCodeChannel.appendLine("[diagnostics] No account name, credential, token, or workspace path was collected.");
    leetCodeChannel.show();
}
