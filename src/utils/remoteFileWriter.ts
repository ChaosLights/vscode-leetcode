// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

import * as vscode from "vscode";
import * as crypto from "crypto";
import { leetCodeChannel } from "../leetCodeChannel";
import {
    IRemoteTextFileOperations,
    IRemoteTextFileRecreateOperations,
    persistRemoteTextFile,
    recreateRemoteTextFile,
    RemoteTextFileWriteError,
    RemoteTextFileWriteResult,
} from "./remoteFileWriteCore";
import {
    WorkspaceFileDeletionRevision,
    workspaceFileDeletionTracker,
} from "./workspaceFileDeletionTracker";

const activeWorkspaceWrites: Map<string, Promise<RemoteTextFileWriteResult>> =
    new Map<string, Promise<RemoteTextFileWriteResult>>();
const liveShareCacheSynchronizationAttempts: number = 40;
const otherRemoteSynchronizationAttempts: number = 5;

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

export async function createWorkspaceTextFileAtomically(
    fileUri: vscode.Uri,
    parentUri: vscode.Uri,
    content: string,
    workspaceRootUri: vscode.Uri,
    deletionRevision?: WorkspaceFileDeletionRevision,
    cancellationToken?: vscode.CancellationToken,
): Promise<RemoteTextFileWriteResult> {
    const operationKey: string = fileUri.toString();
    const activeWrite: Promise<RemoteTextFileWriteResult> | undefined = activeWorkspaceWrites.get(operationKey);
    if (activeWrite) {
        await activeWrite;
        return "existing";
    }

    const writeTask: Promise<RemoteTextFileWriteResult> =
        createWorkspaceTextFileAtomicallyOnce(
            fileUri,
            parentUri,
            content,
            workspaceRootUri,
            deletionRevision,
            cancellationToken,
        );
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

async function createWorkspaceTextFileAtomicallyOnce(
    fileUri: vscode.Uri,
    parentUri: vscode.Uri,
    content: string,
    workspaceRootUri: vscode.Uri,
    deletionRevision?: WorkspaceFileDeletionRevision,
    cancellationToken?: vscode.CancellationToken,
): Promise<RemoteTextFileWriteResult> {
    await assertNoSymbolicLinkInPath(workspaceRootUri, parentUri);
    const stagingUri: vscode.Uri = vscode.Uri.joinPath(
        parentUri,
        `.vscode-leetcode-recreate-${crypto.randomBytes(12).toString("hex")}.tmp`,
    );
    let stagingOwned: boolean = false;
    const synchronizationAttempts: number = fileUri.scheme === "vsls"
        ? liveShareCacheSynchronizationAttempts
        : otherRemoteSynchronizationAttempts;
    const operations: IRemoteTextFileRecreateOperations = {
        synchronizationAttempts,
        verificationAttempts: synchronizationAttempts,
        waitForTargetDeletion: deletionRevision !== undefined,
        createStagingFile: async (stagingContent: string): Promise<void> => {
            const result: RemoteTextFileWriteResult =
                await writeWorkspaceTextFile(stagingUri, parentUri, stagingContent, workspaceRootUri);
            if (result !== "created") {
                throw new Error("The unique staging file unexpectedly already exists.");
            }
            stagingOwned = true;
        },
        targetExists: async (): Promise<boolean> => workspaceTextFileExists(fileUri),
        stagingExists: async (): Promise<boolean> => workspaceTextFileExists(stagingUri),
        deletionStillExpected: (): boolean =>
            deletionRevision !== undefined &&
            workspaceFileDeletionTracker.isDeletionRevisionCurrent(fileUri, deletionRevision),
        deletionWasSuperseded: (): boolean => {
            const currentRevision: WorkspaceFileDeletionRevision | undefined =
                workspaceFileDeletionTracker.getDeletionRevision(fileUri);
            return currentRevision !== undefined && currentRevision !== deletionRevision;
        },
        renameStagingToTarget: async (): Promise<void> => {
            workspaceFileDeletionTracker.expectCreation(fileUri, deletionRevision);
            await vscode.workspace.fs.rename(stagingUri, fileUri, { overwrite: false });
            stagingOwned = false;
        },
        readTargetText: async (): Promise<string> =>
            Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString("utf8"),
        cleanupStagingFile: async (): Promise<void> => {
            if (!stagingOwned) {
                return;
            }
            try {
                await vscode.workspace.fs.delete(stagingUri, { recursive: false, useTrash: false });
                stagingOwned = false;
            } catch (error) {
                if (!isFileNotFoundError(error)) {
                    leetCodeChannel.appendLine(
                        `[Workspace] Failed to clean a unique recreation staging file: ${getErrorMessage(error)}`,
                    );
                }
            }
        },
        isFileExistsError,
        isFileNotFoundError,
        isNoPermissionsError,
        throwIfCancellationRequested: (): void => {
            if (cancellationToken?.isCancellationRequested) {
                throw new vscode.CancellationError();
            }
        },
        waitBeforeSynchronizationRetry: async (attempt: number): Promise<void> => {
            await new Promise<void>((resolve: () => void) =>
                setTimeout(resolve, Math.min(1000, 50 * Math.pow(2, attempt - 1))));
        },
    };

    try {
        const result: RemoteTextFileWriteResult = await recreateRemoteTextFile(operations, content);
        const currentRevision: WorkspaceFileDeletionRevision | undefined =
            workspaceFileDeletionTracker.getDeletionRevision(fileUri);
        if (currentRevision !== undefined && currentRevision !== deletionRevision) {
            throw new RemoteTextFileWriteError(
                "DeletionSuperseded",
                "The shared problem file was deleted again before Code Now finished.",
            );
        }
        if (
            deletionRevision !== undefined &&
            (result === "created" || result === "existing") &&
            currentRevision === deletionRevision
        ) {
            workspaceFileDeletionTracker.recordCreation(fileUri, deletionRevision);
        }
        return result;
    } catch (error) {
        throw createWorkspaceWriteError(fileUri, error);
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

function isFileExistsError(error: any): boolean {
    const code: string = error && typeof error.code === "string" ? error.code : "";
    const name: string = error && typeof error.name === "string" ? error.name : "";
    return code === "FileExists" || name.indexOf("FileExists") >= 0;
}

function isNoPermissionsError(error: any): boolean {
    const code: string = error && typeof error.code === "string" ? error.code : "";
    const name: string = error && typeof error.name === "string" ? error.name : "";
    const message: string = getErrorMessage(error);
    return (
        code === "NoPermissions" ||
        name.indexOf("NoPermissions") >= 0 ||
        /NoPermissions|Access denied|permission denied/i.test(message)
    );
}

function createWorkspaceWriteError(fileUri: vscode.Uri, error: any): Error {
    if (error instanceof vscode.CancellationError) {
        return error;
    }
    const message: string = getErrorMessage(error);
    if (fileUri.scheme === "vsls") {
        if (
            (error instanceof RemoteTextFileWriteError && error.code === "ReadOnly") ||
            isNoPermissionsError(error) ||
            /read[\s-]?only|not writable/i.test(message)
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
        if (error instanceof RemoteTextFileWriteError && error.code === "DeletionSyncTimeout") {
            return new Error(
                `${message} Wait for the shared Explorer to finish updating, then run Code Now again.`,
            );
        }
        if (error instanceof RemoteTextFileWriteError && error.code === "DeletionSuperseded") {
            return new Error(
                `${message} The newer deletion was preserved; run Code Now again when you are ready to recreate it.`,
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
