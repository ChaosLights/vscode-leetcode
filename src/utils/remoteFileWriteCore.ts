// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

export type RemoteTextFileWriteResult = "created" | "existing";

export type RemoteTextFileWriteErrorCode = "ReadOnly" | "VerificationFailed";

export interface IRemoteTextFileOperations {
    readonly writable: boolean | undefined;
    readonly verificationAttempts?: number;
    ensureParentDirectory(): Promise<void>;
    fileExists(): Promise<boolean>;
    createFile(content: string): Promise<void>;
    readText(): Promise<string>;
    waitBeforeVerificationRetry?(attempt: number): Promise<void>;
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
