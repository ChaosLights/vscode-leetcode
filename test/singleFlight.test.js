const assert = require("assert");
const { createSingleFlight } = require("../out/src/utils/singleFlight");

(async () => {
    let resolveOperation;
    let calls = 0;
    const sharedOperation = createSingleFlight(async () => {
        calls++;
        return await new Promise((resolve) => {
            resolveOperation = resolve;
        });
    });

    const first = sharedOperation();
    const second = sharedOperation();
    assert.strictEqual(first, second, "concurrent callers must share the same promise");
    await Promise.resolve();
    assert.strictEqual(calls, 1, "the shared operation must run only once");
    resolveOperation("repaired");
    assert.deepStrictEqual(await Promise.all([first, second]), ["repaired", "repaired"]);

    const afterSuccess = sharedOperation();
    assert.notStrictEqual(afterSuccess, first, "a completed operation must not remain cached");
    await Promise.resolve();
    assert.strictEqual(calls, 2, "a later call must start a new operation");
    resolveOperation("repaired again");
    assert.strictEqual(await afterSuccess, "repaired again");

    let attempts = 0;
    let shouldFail = true;
    const retryableOperation = createSingleFlight(async () => {
        attempts++;
        if (shouldFail) {
            throw new Error("repair failed");
        }
        return true;
    });

    const failedFirst = retryableOperation();
    const failedSecond = retryableOperation();
    assert.strictEqual(failedFirst, failedSecond, "failing callers must also share the same promise");
    const failures = await Promise.allSettled([failedFirst, failedSecond]);
    assert.strictEqual(attempts, 1, "a concurrent failure must still run only once");
    assert.strictEqual(failures[0].status, "rejected");
    assert.strictEqual(failures[1].status, "rejected");

    shouldFail = false;
    const retry = retryableOperation();
    assert.notStrictEqual(retry, failedFirst, "a failed operation must be cleared before retrying");
    assert.strictEqual(await retry, true);
    assert.strictEqual(attempts, 2, "the retry must execute the operation again");

    console.log("Single-flight tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
