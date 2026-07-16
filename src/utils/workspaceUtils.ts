// Copyright (c) jdneo. All rights reserved.
// Licensed under the MIT license.

import * as fse from "fs-extra";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { IQuickItemEx } from "../shared";
import { getWorkspaceConfiguration } from "./settingUtils";
import { showDirectorySelectDialog } from "./uiUtils";
import { resolveRemoteWorkspaceRelativePath } from "./workspacePathUtils";
import * as wsl from "./wslUtils";

export interface IActiveSolutionFile {
    filePath: string;
    dispose(): Promise<void>;
}

export interface IRemoteWorkspaceTarget {
    relativeFolder: string;
    workspaceFolder: vscode.WorkspaceFolder;
}

export function getSafeRelativePathSegments(relativePath: string): string[] {
    const slashPath: string = relativePath.replace(/\\/g, "/");
    const rawSegments: string[] = slashPath.split("/").filter((segment: string) => Boolean(segment));
    if (
        !slashPath ||
        path.posix.isAbsolute(slashPath) ||
        /^[a-z]:\//i.test(slashPath) ||
        rawSegments.some((segment: string) => segment === "." || segment === "..")
    ) {
        throw new Error(`LeetCode filePath must stay inside the shared workspace: ${relativePath}`);
    }
    return rawSegments;
}

export async function selectRemoteWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
    const remoteFolders: vscode.WorkspaceFolder[] = (vscode.workspace.workspaceFolders || [])
        .filter((folder: vscode.WorkspaceFolder) => folder.uri.scheme !== "file");
    if (!remoteFolders.length) {
        return undefined;
    }
    if (remoteFolders.length === 1) {
        return remoteFolders[0];
    }

    const activeUri: vscode.Uri | undefined = vscode.window.activeTextEditor?.document.uri;
    const activeFolder: vscode.WorkspaceFolder | undefined = activeUri
        ? vscode.workspace.getWorkspaceFolder(activeUri)
        : undefined;
    if (activeFolder && activeFolder.uri.scheme !== "file") {
        return activeFolder;
    }

    const picks: Array<IQuickItemEx<vscode.WorkspaceFolder>> = remoteFolders.map(
        (folder: vscode.WorkspaceFolder): IQuickItemEx<vscode.WorkspaceFolder> => ({
            label: folder.name,
            description: folder.uri.toString(true),
            value: folder,
        }),
    );
    return (await vscode.window.showQuickPick(picks, {
        placeHolder: "Select the shared workspace folder for the problem file",
    }))?.value;
}

export async function selectRemoteWorkspaceTarget(configuredPath: string): Promise<IRemoteWorkspaceTarget | undefined> {
    const remoteFolders: vscode.WorkspaceFolder[] = (vscode.workspace.workspaceFolders || [])
        .filter((folder: vscode.WorkspaceFolder) => folder.uri.scheme !== "file");
    if (!remoteFolders.length) {
        return undefined;
    }

    const isAbsoluteConfiguredPath: boolean = path.posix.isAbsolute(configuredPath.replace(/\\/g, "/"));
    if (configuredPath.trim() && isAbsoluteConfiguredPath) {
        const matches: IRemoteWorkspaceTarget[] = remoteFolders
            .map((folder: vscode.WorkspaceFolder): IRemoteWorkspaceTarget | undefined => {
                const mappedRelativeFolder: string | undefined = resolveRemoteWorkspaceRelativePath(
                    configuredPath,
                    folder.uri.path,
                    folder.name,
                    folder.uri.scheme === "vsls",
                );
                return mappedRelativeFolder === undefined
                    ? undefined
                    : { relativeFolder: mappedRelativeFolder, workspaceFolder: folder };
            })
            .filter((target: IRemoteWorkspaceTarget | undefined): target is IRemoteWorkspaceTarget => Boolean(target));
        if (matches.length === 1) {
            return matches[0];
        }
        if (!matches.length) {
            throw new Error(`The configured LeetCode workspace folder is outside the shared workspace: ${configuredPath}`);
        }
    }

    const workspaceFolder: vscode.WorkspaceFolder | undefined = await selectRemoteWorkspaceFolder();
    if (!workspaceFolder) {
        return undefined;
    }
    const relativeFolder: string | undefined = resolveRemoteWorkspaceRelativePath(
        configuredPath,
        workspaceFolder.uri.path,
        workspaceFolder.name,
        workspaceFolder.uri.scheme === "vsls",
    );
    if (relativeFolder === undefined) {
        throw new Error(`Invalid LeetCode workspace folder: ${configuredPath}`);
    }
    return { relativeFolder, workspaceFolder };
}

export async function selectWorkspaceFolder(configuredPath: string): Promise<string> {
    let workspaceFolderSetting: string = configuredPath;
    if (workspaceFolderSetting.trim() === "") {
        workspaceFolderSetting = await determineLeetCodeFolder();
        if (workspaceFolderSetting === "") {
            // User cancelled
            return workspaceFolderSetting;
        }
    }
    let needAsk: boolean = true;
    await fse.ensureDir(workspaceFolderSetting);
    for (const folder of vscode.workspace.workspaceFolders || []) {
        if (isSubFolder(folder.uri.fsPath, workspaceFolderSetting)) {
            needAsk = false;
        }
    }

    if (needAsk) {
        const choice: string | undefined = await vscode.window.showQuickPick(
            [
                OpenOption.justOpenFile,
                OpenOption.openInCurrentWindow,
                OpenOption.openInNewWindow,
                OpenOption.addToWorkspace,
            ],
            { placeHolder: "The LeetCode workspace folder is not opened in VS Code, would you like to open it?" },
        );

        // Todo: generate file first
        switch (choice) {
            case OpenOption.justOpenFile:
                return workspaceFolderSetting;
            case OpenOption.openInCurrentWindow:
                await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(workspaceFolderSetting), false);
                return "";
            case OpenOption.openInNewWindow:
                await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(workspaceFolderSetting), true);
                return "";
            case OpenOption.addToWorkspace:
                vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri: vscode.Uri.file(workspaceFolderSetting) });
                break;
            default:
                return "";
        }
    }

    return wsl.useWsl() ? wsl.toWslPath(workspaceFolderSetting) : workspaceFolderSetting;
}

export async function getActiveFilePath(uri?: vscode.Uri): Promise<string | undefined> {
    let textEditor: vscode.TextEditor | undefined;
    if (uri) {
        textEditor = await vscode.window.showTextDocument(uri, { preview: false });
    } else {
        textEditor = vscode.window.activeTextEditor;
    }

    if (!textEditor) {
        return undefined;
    }
    if (textEditor.document.isDirty && !await textEditor.document.save()) {
        vscode.window.showWarningMessage("Please save the solution file first.");
        return undefined;
    }
    return wsl.useWsl() ? wsl.toWslPath(textEditor.document.uri.fsPath) : textEditor.document.uri.fsPath;
}

export async function getActiveSolutionFile(uri?: vscode.Uri): Promise<IActiveSolutionFile | undefined> {
    const document: vscode.TextDocument | undefined = uri
        ? await vscode.workspace.openTextDocument(uri)
        : vscode.window.activeTextEditor && vscode.window.activeTextEditor.document;

    if (!document) {
        return undefined;
    }

    if (document.uri.scheme === "file") {
        if (document.isDirty && !await document.save()) {
            vscode.window.showWarningMessage("Please save the solution file first.");
            return undefined;
        }
        const currentFilePath: string = document.uri.fsPath;
        return {
            filePath: wsl.useWsl() ? await wsl.toWslPath(currentFilePath) : currentFilePath,
            dispose: async (): Promise<void> => undefined,
        };
    }

    const tempFolder: string = await fse.mkdtemp(path.join(os.tmpdir(), "vscode-leetcode-"));
    const extension: string = path.posix.extname(document.uri.path) || ".txt";
    const tempFilePath: string = path.join(tempFolder, `solution${extension}`);
    try {
        await fse.writeFile(tempFilePath, document.getText(), "utf8");
        const filePath: string = wsl.useWsl() ? await wsl.toWslPath(tempFilePath) : tempFilePath;
        return {
            filePath,
            dispose: async (): Promise<void> => fse.remove(tempFolder),
        };
    } catch (error) {
        await fse.remove(tempFolder);
        throw error;
    }
}

function isSubFolder(from: string, to: string): boolean {
    const relative: string = path.relative(from, to);
    if (relative === "") {
        return true;
    }
    return !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function determineLeetCodeFolder(): Promise<string> {
    let result: string;
    const picks: Array<IQuickItemEx<string>> = [];
    picks.push(
        {
            label: `Default location`,
            detail: `${path.join(os.homedir(), ".leetcode")}`,
            value: `${path.join(os.homedir(), ".leetcode")}`,
        },
        {
            label: "$(file-directory) Browse...",
            value: ":browse",
        },
    );
    const choice: IQuickItemEx<string> | undefined = await vscode.window.showQuickPick(
        picks,
        { placeHolder: "Select where you would like to save your LeetCode files" },
    );
    if (!choice) {
        result = "";
    } else if (choice.value === ":browse") {
        const directory: vscode.Uri[] | undefined = await showDirectorySelectDialog();
        if (!directory || directory.length < 1) {
            result = "";
        } else {
            result = directory[0].fsPath;
        }
    } else {
        result = choice.value;
    }

    getWorkspaceConfiguration().update("workspaceFolder", result, vscode.ConfigurationTarget.Global);

    return result;
}

enum OpenOption {
    justOpenFile = "Just open the problem file",
    openInCurrentWindow = "Open in current window",
    openInNewWindow = "Open in new window",
    addToWorkspace = "Add to workspace",
}
