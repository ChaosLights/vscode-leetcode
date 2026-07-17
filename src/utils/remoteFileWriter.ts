// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

import * as vscode from "vscode";
import {
    IRemoteTextFileOperations,
    persistRemoteTextFile,
    RemoteTextFileWriteError,
    RemoteTextFileWriteResult,
} from "./remoteFileWriteCore";

const activeWorkspaceWrites: Map<string, Promise<RemoteTextFileWriteResult>> =
    new Map<string, Promise<RemoteTextFileWriteResult>>();

class WorkspaceTextFileOperations implements IRemoteTextFileOperations {
    public readonly writable: boolean | undefined;
    public readonly verificationAttempts: number;

    constructor(
        private readonly fileUri: vscode.Uri,
        private readonly parentUri: vscode.Uri | undefined,
    ) {
        this.writable = vscode.workspace.fs.isWritableFileSystem(fileUri.scheme);
        this.verificationAttempts = fileUri.scheme === "vsls" ? 5 : 1;
    }

    public async ensureParentDirectory(): Promise<void> {
        if (this.parentUri) {
            await vscode.workspace.fs.createDirectory(this.parentUri);
        }
    }

    public async fileExists(): Promise<boolean> {
        try {
            const stat: vscode.FileStat = await vscode.workspace.fs.stat(this.fileUri);
            assertUsableFileStat(this.fileUri, stat);
            return true;
        } catch (error) {
            if (isFileNotFoundError(error)) {
                return false;
            }
            throw error;
        }
    }

    public async createFile(content: string): Promise<void> {
        await vscode.workspace.fs.writeFile(this.fileUri, Buffer.from(content, "utf8"));
    }

    public async readText(): Promise<string> {
        return Buffer.from(await vscode.workspace.fs.readFile(this.fileUri)).toString("utf8");
    }

    public async waitBeforeVerificationRetry(attempt: number): Promise<void> {
        await new Promise<void>((resolve: () => void) => setTimeout(resolve, 50 * Math.pow(2, attempt - 1)));
    }
}

export async function writeWorkspaceTextFile(
    fileUri: vscode.Uri,
    parentUri: vscode.Uri | undefined,
    content: string,
    workspaceRootUri?: vscode.Uri,
): Promise<RemoteTextFileWriteResult> {
    const operationKey: string = fileUri.toString();
    const activeWrite: Promise<RemoteTextFileWriteResult> | undefined = activeWorkspaceWrites.get(operationKey);
    if (activeWrite) {
        await activeWrite;
        return "existing";
    }

    const writeTask: Promise<RemoteTextFileWriteResult> =
        writeWorkspaceTextFileOnce(fileUri, parentUri, content, workspaceRootUri);
    activeWorkspaceWrites.set(operationKey, writeTask);
    try {
        return await writeTask;
    } finally {
        if (activeWorkspaceWrites.get(operationKey) === writeTask) {
            activeWorkspaceWrites.delete(operationKey);
        }
    }
}

async function writeWorkspaceTextFileOnce(
    fileUri: vscode.Uri,
    parentUri: vscode.Uri | undefined,
    content: string,
    workspaceRootUri?: vscode.Uri,
): Promise<RemoteTextFileWriteResult> {
    if (workspaceRootUri && parentUri) {
        await assertNoSymbolicLinkInPath(workspaceRootUri, parentUri);
    }
    const operations: WorkspaceTextFileOperations = new WorkspaceTextFileOperations(fileUri, parentUri);
    try {
        return await persistRemoteTextFile(operations, content);
    } catch (error) {
        throw createWorkspaceWriteError(fileUri, error);
    }
}

export async function workspaceTextFileExists(fileUri: vscode.Uri): Promise<boolean> {
    try {
        const stat: vscode.FileStat = await vscode.workspace.fs.stat(fileUri);
        assertUsableFileStat(fileUri, stat);
        return true;
    } catch (error) {
        if (isFileNotFoundError(error)) {
            return false;
        }
        throw error;
    }
}

function assertUsableFileStat(fileUri: vscode.Uri, stat: vscode.FileStat): void {
    if (stat.type === vscode.FileType.Unknown) {
        if (fileUri.scheme === "vsls") {
            throw new Error(
                "Live Share could not confirm the shared file state. " +
                "Reconnect to the Live Share session and try Code Now again.",
            );
        }
        throw new Error(`VS Code could not determine the file type for ${fileUri.toString(true)}.`);
    }
    // tslint:disable-next-line:no-bitwise
    if ((stat.type & vscode.FileType.Directory) !== 0) {
        throw vscode.FileSystemError.FileIsADirectory(fileUri);
    }
}

async function assertNoSymbolicLinkInPath(workspaceRootUri: vscode.Uri, parentUri: vscode.Uri): Promise<void> {
    const rootPath: string = workspaceRootUri.path.replace(/\/+$/, "");
    const parentPath: string = parentUri.path.replace(/\/+$/, "");
    if (parentPath !== rootPath && !parentPath.startsWith(`${rootPath}/`)) {
        throw new Error("The destination folder is outside the selected workspace.");
    }
    const relativePath: string = parentPath.slice(rootPath.length).replace(/^\/+/, "");
    const segments: string[] = relativePath.split("/").filter((segment: string) => Boolean(segment));
    let currentUri: vscode.Uri = workspaceRootUri;
    for (const segment of segments) {
        currentUri = vscode.Uri.joinPath(currentUri, segment);
        try {
            const stat: vscode.FileStat = await vscode.workspace.fs.stat(currentUri);
            // tslint:disable-next-line:no-bitwise
            if ((stat.type & vscode.FileType.SymbolicLink) !== 0) {
                throw new Error(`Refusing to write through a symbolic-link folder: ${currentUri.path}`);
            }
        } catch (error) {
            if (isFileNotFoundError(error)) {
                return;
            }
            throw error;
        }
    }
}

function isFileNotFoundError(error: any): boolean {
    const code: string = error && typeof error.code === "string" ? error.code : "";
    const name: string = error && typeof error.name === "string" ? error.name : "";
    return code === "FileNotFound" || name.indexOf("FileNotFound") >= 0;
}

function createWorkspaceWriteError(fileUri: vscode.Uri, error: any): Error {
    const message: string = getErrorMessage(error);
    if (fileUri.scheme === "vsls") {
        if (
            (error instanceof RemoteTextFileWriteError && error.code === "ReadOnly") ||
            /NoPermissions|read[\s-]?only|not writable/i.test(message)
        ) {
            return new Error(
                "This Live Share session is read-only for you. Ask the host for read/write access, then run Code Now again.",
            );
        }
        if (error instanceof RemoteTextFileWriteError && error.code === "VerificationFailed") {
            return new Error(
                `${message} Reconnect to the Live Share session and try Code Now again.`,
            );
        }
        return new Error(
            `Live Share could not create or update ${fileUri.path}. ` +
            `Confirm that the session is connected and the folder is shared, then try again. Details: ${message}`,
        );
    }
    if (error instanceof RemoteTextFileWriteError && error.code === "ReadOnly") {
        return new Error("The selected remote workspace is read-only.");
    }
    return error instanceof Error ? error : new Error(message);
}

function getErrorMessage(error: any): string {
    return error instanceof Error ? error.message : String(error);
}
