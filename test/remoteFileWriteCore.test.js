const assert = require("assert");
const {
    normalizeTextForComparison,
    persistRemoteTextFile,
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

    console.log("remote file write tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
