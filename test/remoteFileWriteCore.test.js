const assert = require("assert");
const {
    normalizeTextForComparison,
    persistRemoteTextFile,
    recreateRemoteTextFile,
    RemoteTextFileWriteError,
} = require("../out/src/utils/remoteFileWriteCore");

function createOperations(options = {}) {
    let content = options.initialContent;
    const calls = [];
    let readCount = 0;
    return {
        calls,
        operations: {
            writable: options.writable,
            verificationAttempts: options.verificationAttempts,
            async ensureParentDirectory() {
                calls.push("ensureParentDirectory");
            },
            async fileExists() {
                calls.push("fileExists");
                return content !== undefined;
            },
            async createFile(nextContent) {
                calls.push("createFile");
                if (!options.dropWrite) {
                    content = nextContent;
                }
            },
            async readText() {
                calls.push("readText");
                readCount++;
                if (options.visibleAfterRead && readCount >= options.visibleAfterRead) {
                    content = options.delayedContent;
                }
                return content === undefined ? "" : content;
            },
            async waitBeforeVerificationRetry() {
                calls.push("waitBeforeVerificationRetry");
            },
        },
    };
}

function createRecreateOperations(options = {}) {
    const calls = [];
    const targetExistsSequence = [...(options.targetExistsSequence || [false])];
    const stagingExistsSequence = [...(options.stagingExistsSequence || [true])];
    let targetContent = options.targetContent;
    let stagingContent;
    let renameError = options.renameError;
    let superseded = false;
    let targetVisible = options.targetInitiallyVisible === true;
    const nextValue = (sequence, fallback) => sequence.length ? sequence.shift() : fallback;
    return {
        calls,
        getTargetContent: () => targetContent,
        isTargetVisible: () => targetVisible,
        operations: {
            synchronizationAttempts: options.synchronizationAttempts || 5,
            verificationAttempts: options.verificationAttempts || 5,
            waitForTargetDeletion: options.waitForTargetDeletion !== false,
            async createStagingFile(content) {
                calls.push("createStagingFile");
                stagingContent = content;
            },
            async targetExists() {
                calls.push("targetExists");
                const exists = nextValue(targetExistsSequence, options.targetExistsFallback || false);
                if (options.supersedeDuringTargetStat) {
                    superseded = true;
                }
                if (exists && stagingContent === undefined) {
                    targetVisible = true;
                }
                return exists;
            },
            async stagingExists() {
                calls.push("stagingExists");
                const exists = nextValue(stagingExistsSequence, true);
                if (options.supersedeDuringStagingStat) {
                    superseded = true;
                }
                return exists;
            },
            deletionStillExpected() {
                calls.push("deletionStillExpected");
                return options.deletionStillExpected !== false;
            },
            deletionWasSuperseded() {
                calls.push("deletionWasSuperseded");
                return superseded || options.deletionWasSuperseded === true;
            },
            async renameStagingToTarget() {
                calls.push("renameStagingToTarget");
                if (renameError) {
                    const error = renameError;
                    if (!options.persistentRenameError) {
                        renameError = undefined;
                    }
                    throw error;
                }
                targetContent = stagingContent;
                stagingContent = undefined;
            },
            async readTargetText() {
                calls.push("readTargetText");
                if (options.supersedeDuringRead) {
                    superseded = true;
                }
                return targetVisible ? targetContent : options.staleTargetContent;
            },
            async cleanupStagingFile() {
                calls.push("cleanupStagingFile");
                stagingContent = undefined;
            },
            isFileExistsError(error) {
                return error && error.code === "FileExists";
            },
            isFileNotFoundError(error) {
                return error && error.code === "FileNotFound";
            },
            isNoPermissionsError(error) {
                return error && error.code === "NoPermissions";
            },
            async waitBeforeSynchronizationRetry() {
                calls.push("waitBeforeSynchronizationRetry");
            },
        },
    };
}

async function assertRejectsWithCode(promise, code) {
    await assert.rejects(
        promise,
        (error) => error instanceof RemoteTextFileWriteError && error.code === code,
    );
}

(async () => {
    assert.strictEqual(normalizeTextForComparison("\uFEFFa\r\nb\r"), "a\nb\n");

    const createCase = createOperations({ writable: true });
    assert.strictEqual(await persistRemoteTextFile(createCase.operations, "new\n"), "created");
    assert.deepStrictEqual(
        createCase.calls,
        ["ensureParentDirectory", "fileExists", "createFile", "readText"],
    );

    const existingCase = createOperations({ writable: true, initialContent: "old\r\n" });
    assert.strictEqual(await persistRemoteTextFile(existingCase.operations, "new\n"), "existing");
    assert.deepStrictEqual(
        existingCase.calls,
        ["ensureParentDirectory", "fileExists"],
    );

    const readOnlyCase = createOperations({ writable: false });
    await assertRejectsWithCode(persistRemoteTextFile(readOnlyCase.operations, "new"), "ReadOnly");
    assert.deepStrictEqual(readOnlyCase.calls, []);

    const droppedCreateCase = createOperations({ writable: true, dropWrite: true });
    await assertRejectsWithCode(
        persistRemoteTextFile(droppedCreateCase.operations, "new"),
        "VerificationFailed",
    );

    const delayedCreateCase = createOperations({
        writable: true,
        dropWrite: true,
        delayedContent: "new",
        verificationAttempts: 3,
        visibleAfterRead: 3,
    });
    assert.strictEqual(await persistRemoteTextFile(delayedCreateCase.operations, "new"), "created");
    assert.strictEqual(
        delayedCreateCase.calls.filter((call) => call === "waitBeforeVerificationRetry").length,
        2,
    );

    const staleDeletionCase = createRecreateOperations({
        targetExistsSequence: [true, true, false, false, true],
        stagingExistsSequence: [false, true],
    });
    assert.strictEqual(
        await recreateRemoteTextFile(staleDeletionCase.operations, "recreated\n"),
        "created",
    );
    assert.strictEqual(staleDeletionCase.getTargetContent(), "recreated\n");
    assert.strictEqual(
        staleDeletionCase.calls.filter((call) => call === "renameStagingToTarget").length,
        1,
    );
    assert.strictEqual(staleDeletionCase.calls.includes("cleanupStagingFile"), false);
    assert.strictEqual(staleDeletionCase.isTargetVisible(), true);

    const identicalStaleReadCase = createRecreateOperations({
        staleTargetContent: "same template\n",
        targetExistsSequence: [false, false, true],
    });
    assert.strictEqual(
        await recreateRemoteTextFile(identicalStaleReadCase.operations, "same template\n"),
        "created",
    );
    assert.strictEqual(identicalStaleReadCase.isTargetVisible(), true);
    assert.strictEqual(
        identicalStaleReadCase.calls.filter((call) => call === "targetExists").length,
        3,
    );

    const expiredDeletionRevisionCase = createRecreateOperations({
        deletionStillExpected: false,
        targetExistsSequence: [false, true],
    });
    assert.strictEqual(
        await recreateRemoteTextFile(expiredDeletionRevisionCase.operations, "safe create\n"),
        "created",
    );
    assert.strictEqual(
        expiredDeletionRevisionCase.calls.filter((call) => call === "renameStagingToTarget").length,
        1,
    );

    const concurrentlyRecreatedCase = createRecreateOperations({
        deletionStillExpected: false,
        targetContent: "peer solution\n",
        targetExistsSequence: [true],
    });
    assert.strictEqual(
        await recreateRemoteTextFile(concurrentlyRecreatedCase.operations, "must not overwrite\n"),
        "existing",
    );
    assert.strictEqual(concurrentlyRecreatedCase.getTargetContent(), "peer solution\n");
    assert.strictEqual(concurrentlyRecreatedCase.calls.includes("renameStagingToTarget"), false);
    assert.strictEqual(concurrentlyRecreatedCase.calls.includes("cleanupStagingFile"), true);

    const fileExistsError = new Error("concurrent target");
    fileExistsError.code = "FileExists";
    const atomicNoClobberCase = createRecreateOperations({
        renameError: fileExistsError,
        targetContent: "peer solution\n",
        targetExistsSequence: [false, true],
        waitForTargetDeletion: false,
    });
    assert.strictEqual(
        await recreateRemoteTextFile(atomicNoClobberCase.operations, "must not overwrite\n"),
        "existing",
    );
    assert.strictEqual(atomicNoClobberCase.getTargetContent(), "peer solution\n");
    assert.strictEqual(atomicNoClobberCase.calls.includes("cleanupStagingFile"), true);

    const noPermissionsConflict = new Error("Access denied");
    noPermissionsConflict.code = "NoPermissions";
    const ambiguousNoClobberCase = createRecreateOperations({
        renameError: noPermissionsConflict,
        targetContent: "peer solution\n",
        targetExistsSequence: [false, true],
        waitForTargetDeletion: false,
    });
    assert.strictEqual(
        await recreateRemoteTextFile(ambiguousNoClobberCase.operations, "must not overwrite\n"),
        "existing",
    );
    assert.strictEqual(ambiguousNoClobberCase.getTargetContent(), "peer solution\n");
    assert.strictEqual(ambiguousNoClobberCase.calls.includes("cleanupStagingFile"), true);

    const persistentPermissionError = new Error("Access denied");
    persistentPermissionError.code = "NoPermissions";
    const persistentPermissionCase = createRecreateOperations({
        persistentRenameError: true,
        renameError: persistentPermissionError,
        synchronizationAttempts: 3,
        targetExistsFallback: false,
        waitForTargetDeletion: false,
    });
    await assert.rejects(
        recreateRemoteTextFile(persistentPermissionCase.operations, "must not overwrite\n"),
        (error) => error === persistentPermissionError,
    );
    assert.strictEqual(
        persistentPermissionCase.calls.filter((call) => call === "renameStagingToTarget").length,
        3,
    );
    assert.strictEqual(persistentPermissionCase.calls.includes("cleanupStagingFile"), true);

    for (const supersedeOption of [
        "supersedeDuringTargetStat",
        "supersedeDuringStagingStat",
        "supersedeDuringRead",
    ]) {
        const supersededCase = createRecreateOperations({
            [supersedeOption]: true,
            targetExistsSequence: supersedeOption === "supersedeDuringRead"
                ? [false, true]
                : [false],
        });
        await assertRejectsWithCode(
            recreateRemoteTextFile(supersededCase.operations, "new\n"),
            "DeletionSuperseded",
        );
        if (supersedeOption !== "supersedeDuringRead") {
            assert.strictEqual(supersededCase.calls.includes("readTargetText"), false);
        }
        if (supersedeOption === "supersedeDuringTargetStat") {
            assert.strictEqual(supersededCase.calls.includes("renameStagingToTarget"), false);
        }
    }

    const synchronizationTimeoutCase = createRecreateOperations({
        synchronizationAttempts: 3,
        targetExistsFallback: true,
        targetExistsSequence: [true, true, true],
    });
    await assertRejectsWithCode(
        recreateRemoteTextFile(synchronizationTimeoutCase.operations, "new\n"),
        "DeletionSyncTimeout",
    );
    assert.strictEqual(
        synchronizationTimeoutCase.calls.filter((call) => call === "waitBeforeSynchronizationRetry").length,
        2,
    );
    assert.strictEqual(synchronizationTimeoutCase.calls.includes("cleanupStagingFile"), true);

    console.log("remote file write tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
