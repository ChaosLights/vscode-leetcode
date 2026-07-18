"use strict";

const assert = require("assert");
const githubCli = require("../out/src/pairing/githubCli");

const selected = githubCli.selectCodespaceMachine([
    {
        name: "standardLinux32gb",
        display_name: "4 cores",
        operating_system: "linux",
        cpus: 4,
        memory_in_bytes: 16,
        storage_in_bytes: 32,
    },
    {
        name: "basicLinux32gb",
        display_name: "2 cores",
        operating_system: "linux",
        cpus: 2,
        memory_in_bytes: 8,
        storage_in_bytes: 32,
    },
    {
        name: "windows",
        display_name: "Windows",
        operating_system: "windows",
        cpus: 1,
        memory_in_bytes: 4,
        storage_in_bytes: 16,
    },
]);
assert.ok(selected);
assert.strictEqual(selected.name, "basicLinux32gb");
assert.strictEqual(githubCli.selectCodespaceMachine([]), undefined);

assert.strictEqual(
    githubCli.summarizeGitHubCliError(
        "✓ Codespaces usage for this repository is paid for by abandon1232\n" +
        "error creating codespace: machine type is required\n",
        "fallback",
    ),
    "error creating codespace: machine type is required",
);
assert.strictEqual(
    githubCli.summarizeGitHubCliError(
        "✓ Codespaces usage for this repository is paid for by abandon1232\n",
        "Command failed with exit code 1",
    ),
    "Command failed with exit code 1",
);
assert.strictEqual(
    githubCli.summarizeGitHubCliError("failed at https://secret.example/token", "fallback"),
    "failed at [redacted URL]",
);

(async () => {
    const calls = [];
    const cli = new githubCli.GitHubCli();
    cli.run = async (args) => {
        calls.push(args);
        if (args[0] === "api") {
            return JSON.stringify({
                machines: [
                    {
                        name: "basicLinux32gb",
                        display_name: "2 cores",
                        operating_system: "linux",
                        cpus: 2,
                        memory_in_bytes: 8,
                        storage_in_bytes: 32,
                    },
                ],
            });
        }
        return "friendly-codespace-123\n";
    };
    const name = await cli.createCodespace({
        repository: "ChaosLights/lc",
        issueNumber: 8,
        branch: "main",
    });
    assert.strictEqual(name, "friendly-codespace-123");
    assert.deepStrictEqual(calls[0], ["api", "repos/ChaosLights/lc/codespaces/machines"]);
    assert.ok(calls[1].includes("--machine"));
    assert.ok(calls[1].includes("basicLinux32gb"));
    assert.ok(calls[1].includes("--default-permissions"));

    const candidateTarget = {
        repository: "ChaosLights/lc",
        issueNumber: 8,
        branch: "main",
    };
    const candidateBody = [
        "LeetCode Pairing election record for `ChaosLights`.",
        "<!-- leetcode-pairing-candidate",
        JSON.stringify({
            version: 1,
            generation: 9,
            login: "ChaosLights",
            nonce: "0123456789abcdef0123456789abcdef",
            createdAt: "2026-07-18T10:30:00.000Z",
        }),
        "-->",
    ].join("\n");
    const oldCandidate = candidateBody.replace('"generation":9', '"generation":8');
    const upsertCalls = [];
    const upsertCli = new githubCli.GitHubCli();
    upsertCli.run = async (args) => {
        upsertCalls.push(args);
        if (args.includes("--paginate")) {
            return JSON.stringify([[
                {
                    id: 101,
                    created_at: "2026-07-18T08:00:00Z",
                    updated_at: "2026-07-18T09:00:00Z",
                    body: oldCandidate,
                    user: { login: "ChaosLights" },
                },
                {
                    id: 102,
                    created_at: "2026-07-18T08:30:00Z",
                    updated_at: "2026-07-18T09:30:00Z",
                    body: oldCandidate,
                    user: { login: "ChaosLights" },
                },
                {
                    id: 103,
                    created_at: "2026-07-18T08:45:00Z",
                    updated_at: "2026-07-18T09:45:00Z",
                    body: oldCandidate,
                    user: { login: "another-user" },
                },
            ]]);
        }
        if (args.includes("PATCH")) {
            return JSON.stringify({
                id: 101,
                created_at: "2026-07-18T08:00:00Z",
                updated_at: "2026-07-18T10:30:01Z",
                body: candidateBody,
                user: { login: "ChaosLights" },
            });
        }
        return "";
    };
    const updated = await upsertCli.upsertCandidate(candidateTarget, "ChaosLights", candidateBody);
    assert.strictEqual(updated.id, 101);
    assert.strictEqual(updated.updatedAt, "2026-07-18T10:30:01Z");
    assert.strictEqual(updated.authorLogin, "ChaosLights");
    assert.ok(upsertCalls.some((args) =>
        args.includes("PATCH") && args.includes("repos/ChaosLights/lc/issues/comments/101"),
    ));
    assert.ok(upsertCalls.some((args) =>
        args.includes("DELETE") && args.includes("repos/ChaosLights/lc/issues/comments/102"),
    ));
    assert.ok(!upsertCalls.some((args) =>
        args.includes("DELETE") && args.includes("repos/ChaosLights/lc/issues/comments/103"),
    ));

    const createCalls = [];
    const createCli = new githubCli.GitHubCli();
    createCli.run = async (args) => {
        createCalls.push(args);
        if (args.includes("--paginate")) {
            return JSON.stringify([[]]);
        }
        return JSON.stringify({
            id: 201,
            created_at: "2026-07-18T10:30:00Z",
            updated_at: "2026-07-18T10:30:00Z",
            body: candidateBody,
            user: { login: "ChaosLights" },
        });
    };
    const created = await createCli.upsertCandidate(candidateTarget, "ChaosLights", candidateBody);
    assert.strictEqual(created.id, 201);
    assert.ok(createCalls.some((args) =>
        args.includes("POST") && args.includes("repos/ChaosLights/lc/issues/8/comments"),
    ));
    console.log("githubCli tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
