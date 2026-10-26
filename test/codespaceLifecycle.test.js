"use strict";

const assert = require("assert");
const lifecycle = require("../out/src/pairing/codespaceLifecycle");

// Replays the 2026-10-26 incident: the host Codespace was idle-stopped, the
// launcher was rerun while GitHub still reported ShuttingDown, and the old
// allow-list skipped it and created an empty replacement from main.
const incidentList = [
    {
        name: "effective-fishstick-g99rxrx9xrgfv9v5",
        state: "ShuttingDown",
        lastUsedAt: "2026-10-26T04:35:39Z",
    },
];
assert.strictEqual(
    lifecycle.selectReusableCodespace(incidentList).name,
    "effective-fishstick-g99rxrx9xrgfv9v5",
    "a Codespace that is still stopping must be reused, not replaced",
);

// Every state GitHub may report, except Deleted, keeps the existing Codespace.
for (const state of [
    "Available", "Shutdown", "ShuttingDown", "Starting", "Queued", "Provisioning", "Rebuilding",
    "Awaiting", "Exporting", "Updating", "Created", "Moved", "Unknown", "Failed", "Unavailable",
    "Archived", "SomeFutureState",
]) {
    const selected = lifecycle.selectReusableCodespace([
        { name: "existing", state, lastUsedAt: "2026-10-26T04:35:39Z" },
    ]);
    assert.ok(selected, `state ${state} must not cause a replacement Codespace`);
    assert.strictEqual(selected.name, "existing");
}

// Only deleted Codespaces (or none at all) allow a new one to be created.
assert.strictEqual(lifecycle.selectReusableCodespace([]), undefined);
assert.strictEqual(
    lifecycle.selectReusableCodespace([{ name: "gone", state: "Deleted", lastUsedAt: "2026-10-26T04:35:39Z" }]),
    undefined,
);

// The most recently used Codespace wins regardless of its state, so a newer
// stopping/failed Codespace is never shadowed by an older healthy one.
assert.strictEqual(
    lifecycle.selectReusableCodespace([
        { name: "older-available", state: "Available", lastUsedAt: "2026-10-20T00:00:00Z" },
        { name: "newer-stopping", state: "ShuttingDown", lastUsedAt: "2026-10-26T04:35:39Z" },
        { name: "newest-deleted", state: "Deleted", lastUsedAt: "2026-10-26T07:00:00Z" },
    ]).name,
    "newer-stopping",
);

// Missing or malformed timestamps sort last but still prevent a replacement.
assert.strictEqual(
    lifecycle.selectReusableCodespace([
        { name: "no-timestamp", state: "Shutdown", lastUsedAt: "" },
        { name: "dated", state: "Shutdown", lastUsedAt: "2026-10-01T00:00:00Z" },
    ]).name,
    "dated",
);
assert.strictEqual(
    lifecycle.selectReusableCodespace([
        { name: "first-undated", state: "Shutdown", lastUsedAt: "" },
        { name: "second-undated", state: "Available", lastUsedAt: "not a date" },
    ]).name,
    "first-undated",
);

function createHooks(states, options = {}) {
    const calls = { start: 0, waits: [], reports: [], stateEvents: [], getState: 0 };
    let clock = 0;
    const hooks = {
        getState: async () => {
            const index = Math.min(calls.getState, states.length - 1);
            calls.getState++;
            return states[index];
        },
        start: async () => {
            calls.start++;
            calls.startedAfterReads = calls.getState;
        },
        wait: async (ms) => {
            calls.waits.push(ms);
            clock += ms;
        },
        throwIfCancelled: () => {
            if (options.cancelAfterReads !== undefined && calls.getState >= options.cancelAfterReads) {
                const error = new Error("Pairing was cancelled.");
                error.name = "LeetCodePairingCancelled";
                throw error;
            }
        },
        now: () => clock,
        onState: (state) => calls.stateEvents.push(state),
        report: (message) => calls.reports.push(message),
    };
    return { hooks, calls };
}

(async () => {
    // Incident replay: wait for ShuttingDown, start exactly once after Shutdown.
    {
        const { hooks, calls } = createHooks(["ShuttingDown", "ShuttingDown", "Shutdown", "Starting", "Available"]);
        await lifecycle.waitForCodespaceAvailable("effective-fishstick-g99rxrx9xrgfv9v5", hooks, 10 * 60_000);
        assert.strictEqual(calls.start, 1, "start must be requested exactly once");
        assert.strictEqual(calls.startedAfterReads, 3, "start must wait until GitHub reports Shutdown");
        assert.deepStrictEqual(
            calls.stateEvents,
            ["ShuttingDown", "ShuttingDown", "Shutdown", "Starting", "Available"],
        );
        assert.ok(calls.reports[0].includes("finish stopping"));
        assert.ok(calls.reports.includes("Starting the host Codespace..."));
        assert.deepStrictEqual(calls.waits, [5_000, 5_000, 5_000, 5_000]);
    }

    // Already available: no start request and no wait.
    {
        const { hooks, calls } = createHooks(["Available"]);
        await lifecycle.waitForCodespaceAvailable("ready", hooks, 10 * 60_000);
        assert.strictEqual(calls.start, 0);
        assert.deepStrictEqual(calls.waits, []);
    }

    // Shutdown is started once even if GitHub keeps reporting it briefly.
    {
        const { hooks, calls } = createHooks(["Shutdown", "Shutdown", "Queued", "Available"]);
        await lifecycle.waitForCodespaceAvailable("cold", hooks, 10 * 60_000);
        assert.strictEqual(calls.start, 1);
    }

    // Blocked states fail loudly instead of falling back to a new Codespace.
    for (const state of ["Failed", "Unavailable", "Archived", "Deleted"]) {
        const { hooks, calls } = createHooks(["ShuttingDown", state]);
        await assert.rejects(
            lifecycle.waitForCodespaceAvailable("stuck", hooks, 10 * 60_000),
            (error) => {
                assert.ok(error.message.includes("stuck"));
                assert.ok(error.message.includes(`state: ${state}`));
                assert.ok(error.message.includes("no replacement Codespace was created"));
                return true;
            },
        );
        assert.strictEqual(calls.start, 0);
    }

    // A Codespace that never finishes stopping times out without a start request.
    {
        const { hooks, calls } = createHooks(["ShuttingDown"]);
        await assert.rejects(
            lifecycle.waitForCodespaceAvailable("slow", hooks, 10 * 60_000),
            /did not become available within 10 minutes\. No replacement Codespace was created/,
        );
        assert.strictEqual(calls.start, 0);
        assert.strictEqual(calls.getState, 120);
    }

    // Cancellation propagates unchanged.
    {
        const { hooks, calls } = createHooks(["ShuttingDown"], { cancelAfterReads: 2 });
        await assert.rejects(
            lifecycle.waitForCodespaceAvailable("cancelled", hooks, 10 * 60_000),
            (error) => error.name === "LeetCodePairingCancelled",
        );
        assert.strictEqual(calls.getState, 2);
    }

    console.log("codespaceLifecycle tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
