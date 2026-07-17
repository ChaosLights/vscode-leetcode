// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

export type RemoteTextFileWriteResult = "created" | "existing";

export type RemoteTextFileWriteErrorCode =
    "DeletionSuperseded" | "DeletionSyncTimeout" | "ReadOnly" | "VerificationFailed";

export interface IRemoteTextFileOperations {
    readonly writable: boolean | undefined;
    readonly verificationAttempts?: number;
    ensureParentDirectory(): Promise<void>;
    fileExists(): Promise<boolean>;
    createFile(content: string): Promise<void>;
    readText(): Promise<string>;
    waitBeforeVerificationRetry?(attempt: number): Promise<void>;
}

export interface IRemoteTextFileRecreateOperations {
    readonly synchronizationAttempts?: number;
    readonly verificationAttempts?: number;
    readonly waitForTargetDeletion: boolean;
    createStagingFile(content: string): Promise<void>;
    targetExists(): Promise<boolean>;
    stagingExists(): Promise<boolean>;
    deletionStillExpected(): boolean;
    deletionWasSuperseded(): boolean;
    renameStagingToTarget(): Promise<void>;
    readTargetText(): Promise<string>;
    cleanupStagingFile(): Promise<void>;
    isFileExistsError(error: any): boolean;
    isFileNotFoundError(error: any): boolean;
    isNoPermissionsError(error: any): boolean;
    throwIfCancellationRequested?(): void;
    waitBeforeSynchronizationRetry?(attempt: number): Promise<void>;
}

export class RemoteTextFileWriteError extends Error {
    constructor(public readonly code: RemoteTextFileWriteErrorCode, message: string) {
        super(message);
        this.name = "RemoteTextFileWriteError";
        Object.setPrototypeOf(this, RemoteTextFileWriteError.prototype);
    }
}

export function normalizeTextForComparison(content: string): string {
    return content
        .replace(/^\uFEFF/, "")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n");
}

export async function persistRemoteTextFile(
    operations: IRemoteTextFileOperations,
    content: string,
): Promise<RemoteTextFileWriteResult> {
    if (operations.writable === false) {
        throw new RemoteTextFileWriteError("ReadOnly", "The selected workspace is read-only.");
    }

    await operations.ensureParentDirectory();
    const existed: boolean = await operations.fileExists();
    if (existed) {
        return "existing";
    }

    await operations.createFile(content);
    const verificationAttempts: number = Math.max(1, operations.verificationAttempts || 1);
    let lastReadError: any;
    for (let attempt: number = 1; attempt <= verificationAttempts; attempt++) {
        try {
            const persistedContent: string = await operations.readText();
            if (normalizeTextForComparison(persistedContent) === normalizeTextForComparison(content)) {
                return "created";
            }
            lastReadError = undefined;
        } catch (error) {
            lastReadError = error;
        }
        if (attempt < verificationAttempts && operations.waitBeforeVerificationRetry) {
            await operations.waitBeforeVerificationRetry(attempt);
        }
    }
    const readFailure: string = lastReadError
        ? ` The final verification read failed: ${lastReadError instanceof Error ? lastReadError.message : String(lastReadError)}`
        : "";
    throw new RemoteTextFileWriteError(
        "VerificationFailed",
        `VS Code reported a successful write, but the shared file content did not update.${readFailure}`,
    );
}

export async function recreateRemoteTextFile(
    operations: IRemoteTextFileRecreateOperations,
    content: string,
): Promise<RemoteTextFileWriteResult> {
    let renamed: boolean = false;
    try {
        await operations.createStagingFile(content);
        const synchronizationAttempts: number = Math.max(1, operations.synchronizationAttempts || 1);
        let observedTargetMissing: boolean = false;
        let ambiguousRenameError: any;
        for (let attempt: number = 1; attempt <= synchronizationAttempts; attempt++) {
            assertOperationCanContinue(operations);
            const targetExists: boolean = await operations.targetExists();
            assertOperationCanContinue(operations);
            if (targetExists) {
                if (
                    !operations.waitForTargetDeletion ||
                    !operations.deletionStillExpected() ||
                    observedTargetMissing ||
                    ambiguousRenameError
                ) {
                    return "existing";
                }
            } else {
                observedTargetMissing = true;
            }
            if (!targetExists) {
                const stagingExists: boolean = await operations.stagingExists();
                assertOperationCanContinue(operations);
                if (!stagingExists) {
                    if (
                        attempt < synchronizationAttempts &&
                        operations.waitBeforeSynchronizationRetry
                    ) {
                        await operations.waitBeforeSynchronizationRetry(attempt);
                    }
                    continue;
                }
                try {
                    await operations.renameStagingToTarget();
                    renamed = true;
                    break;
                } catch (error) {
                    if (
                        operations.isFileExistsError(error) ||
                        operations.isNoPermissionsError(error)
                    ) {
                        ambiguousRenameError = error;
                    }
                    if (
                        !operations.isFileExistsError(error) &&
                        !operations.isNoPermissionsError(error) &&
                        !operations.isFileNotFoundError(error)
                    ) {
                        throw error;
                    }
                }
            }

            if (
                attempt < synchronizationAttempts &&
                operations.waitBeforeSynchronizationRetry
            ) {
                await operations.waitBeforeSynchronizationRetry(attempt);
            }
        }

        if (!renamed) {
            if (ambiguousRenameError) {
                throw ambiguousRenameError;
            }
            throw new RemoteTextFileWriteError(
                "DeletionSyncTimeout",
                "Live Share is still synchronizing the shared problem file; no existing file was overwritten.",
            );
        }

        const verificationAttempts: number = Math.max(
            1,
            operations.verificationAttempts || synchronizationAttempts,
        );
        let lastReadError: any;
        for (let attempt: number = 1; attempt <= verificationAttempts; attempt++) {
            assertOperationCanContinue(operations);
            const targetExists: boolean = await operations.targetExists();
            assertOperationCanContinue(operations);
            if (targetExists) {
                let targetContent: string | undefined;
                try {
                    targetContent = await operations.readTargetText();
                } catch (error) {
                    lastReadError = error;
                }
                assertOperationCanContinue(operations);
                if (
                    targetContent !== undefined &&
                    normalizeTextForComparison(targetContent) === normalizeTextForComparison(content)
                ) {
                    return "created";
                }
                if (targetContent !== undefined) {
                    lastReadError = undefined;
                }
            }
            if (
                attempt < verificationAttempts &&
                operations.waitBeforeSynchronizationRetry
            ) {
                await operations.waitBeforeSynchronizationRetry(attempt);
            }
        }

        const readFailure: string = lastReadError
            ? ` The final verification read failed: ${
                lastReadError instanceof Error ? lastReadError.message : String(lastReadError)
            }`
            : "";
        throw new RemoteTextFileWriteError(
            "VerificationFailed",
            `The deleted file was recreated, but Live Share did not expose the new content.${readFailure}`,
        );
    } finally {
        if (!renamed) {
            await operations.cleanupStagingFile();
        }
    }
}

function assertOperationCanContinue(operations: IRemoteTextFileRecreateOperations): void {
    operations.throwIfCancellationRequested?.();
    if (operations.deletionWasSuperseded()) {
        throw new RemoteTextFileWriteError(
            "DeletionSuperseded",
            "The shared problem file was deleted again while Code Now was recreating it.",
        );
    }
}
