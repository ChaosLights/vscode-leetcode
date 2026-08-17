const assert = require("assert");
const {
    canSafelyRetryJudgeOperation,
    isCliCloudflareChallengeError,
    isCliSessionExpiredError,
    runWithCliSessionRecovery,
} = require("../out/src/utils/cliSessionRecovery");

function expiredError(stderr = "- Sending code to judge\n") {
    const error = new Error('LeetCode CLI command failed with exit code "0".');
    error.result = "[ERROR] session expired, please login again [code=-1]\n";
    error.stderr = stderr;
    return error;
}

(async () => {
    assert.strictEqual(isCliSessionExpiredError(expiredError()), true);
    assert.strictEqual(isCliSessionExpiredError(new Error("compile failed")), false);
    const cloudflareError = new Error("CLI failed");
    cloudflareError.result = "[ERROR] Cloudflare security challenge blocked this LeetCode request [code=403]";
    assert.strictEqual(isCliCloudflareChallengeError(cloudflareError), true);
    assert.strictEqual(isCliSessionExpiredError(cloudflareError), false);
    assert.strictEqual(canSafelyRetryJudgeOperation(cloudflareError, "test"), false);
    const legacyCloudflareError = new Error("Cloudflare security challenge blocked this code payload");
    assert.strictEqual(isCliCloudflareChallengeError(legacyCloudflareError), true);
    assert.strictEqual(canSafelyRetryJudgeOperation(expiredError(), "test"), true);
    assert.strictEqual(canSafelyRetryJudgeOperation(expiredError(), "submit"), true);
    assert.strictEqual(
        canSafelyRetryJudgeOperation(expiredError("- Waiting for judge result\n"), "submit"),
        false,
        "a submission must not be duplicated after the judge accepted it",
    );

    const waits = [];
    const retries = [];
    let calls = 0;
    let repairs = 0;
    const recovered = await runWithCliSessionRecovery(
        "test",
        async () => {
            calls++;
            if (calls < 3) {
                throw expiredError();
            }
            return "ok";
        },
        async () => {
            repairs++;
            return true;
        },
        {
            onRetry: (attempt, delayMilliseconds) => retries.push([attempt, delayMilliseconds]),
            wait: async (delayMilliseconds) => waits.push(delayMilliseconds),
        },
    );
    assert.strictEqual(recovered, "ok");
    assert.strictEqual(calls, 3);
    assert.strictEqual(repairs, 1);
    assert.deepStrictEqual(waits, [5000, 10000]);
    assert.deepStrictEqual(retries, [[1, 5000], [2, 10000]]);

    calls = 0;
    await assert.rejects(
        () => runWithCliSessionRecovery(
            "submit",
            async () => {
                calls++;
                throw expiredError("- Waiting for judge result\n");
            },
            async () => true,
            { wait: async () => undefined },
        ),
        /exit code/,
    );
    assert.strictEqual(calls, 1);

    console.log("CLI session recovery tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
