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
    githubCli.summarizeGitHubError(
        "✓ Codespaces usage for this repository is paid for by abandon1232\n" +
        "error creating codespace: machine type is required\n",
        "fallback",
    ),
    "error creating codespace: machine type is required",
);
assert.strictEqual(
    githubCli.summarizeGitHubError(
        "✓ Codespaces usage for this repository is paid for by abandon1232\n",
        "Command failed with exit code 1",
    ),
    "Command failed with exit code 1",
);
assert.strictEqual(
    githubCli.summarizeGitHubError("failed at https://secret.example/token", "fallback"),
    "failed at [redacted URL]",
);
assert.strictEqual(
    githubCli.summarizeGitHubError("token github_pat_012345678901234567890123456789", "fallback"),
    "token [redacted token]",
);

const target = {
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
const accessToken = "github_pat_012345678901234567890123456789";

(async () => {
    const createRequests = [];
    let tokenRequests = 0;
    const createCli = new githubCli.GitHubCli(
        async () => {
            tokenRequests++;
            return accessToken;
        },
        async (request) => {
            createRequests.push(request);
            if (request.endpoint.endsWith("/machines")) {
                return {
                    status: 200,
                    data: {
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
                    },
                };
            }
            return {
                status: 201,
                data: { name: "friendly-codespace-123", state: "Provisioning" },
            };
        },
    );
    const name = await createCli.createCodespace(target);
    assert.strictEqual(name, "friendly-codespace-123");
    assert.strictEqual(tokenRequests, 1, "the access token should be cached in memory");
    assert.strictEqual(createRequests[0].method, "GET");
    assert.strictEqual(createRequests[0].endpoint, "repos/ChaosLights/lc/codespaces/machines");
    assert.strictEqual(createRequests[1].method, "POST");
    assert.strictEqual(createRequests[1].endpoint, "repos/ChaosLights/lc/codespaces");
    assert.strictEqual(createRequests[1].data.machine, "basicLinux32gb");
    assert.strictEqual(createRequests[1].data.multi_repo_permissions_opt_out, true);
    assert.strictEqual(createRequests[1].data.retention_period_minutes, 4320);

    const upsertRequests = [];
    const upsertCli = new githubCli.GitHubCli(
        async () => accessToken,
        async (request) => {
            upsertRequests.push(request);
            if (request.method === "GET") {
                return {
                    status: 200,
                    data: [
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
                    ],
                };
            }
            if (request.method === "PATCH") {
                return {
                    status: 200,
                    data: {
                        id: 101,
                        created_at: "2026-07-18T08:00:00Z",
                        updated_at: "2026-07-18T10:30:01Z",
                        body: candidateBody,
                        user: { login: "ChaosLights" },
                    },
                };
            }
            return { status: 204, data: undefined };
        },
    );
    const updated = await upsertCli.upsertCandidate(target, "ChaosLights", candidateBody);
    assert.strictEqual(updated.id, 101);
    assert.strictEqual(updated.updatedAt, "2026-07-18T10:30:01Z");
    assert.strictEqual(updated.authorLogin, "ChaosLights");
    assert.ok(upsertRequests.some((request) =>
        request.method === "PATCH" && request.endpoint === "repos/ChaosLights/lc/issues/comments/101",
    ));
    assert.ok(upsertRequests.some((request) =>
        request.method === "DELETE" && request.endpoint === "repos/ChaosLights/lc/issues/comments/102",
    ));
    assert.ok(!upsertRequests.some((request) =>
        request.method === "DELETE" && request.endpoint === "repos/ChaosLights/lc/issues/comments/103",
    ));

    const candidateRequests = [];
    const candidateCli = new githubCli.GitHubCli(
        async () => accessToken,
        async (request) => {
            candidateRequests.push(request);
            if (request.method === "GET") {
                return { status: 200, data: [] };
            }
            return {
                status: 201,
                data: {
                    id: 201,
                    created_at: "2026-07-18T10:30:00Z",
                    updated_at: "2026-07-18T10:30:00Z",
                    body: candidateBody,
                    user: { login: "ChaosLights" },
                },
            };
        },
    );
    const created = await candidateCli.upsertCandidate(target, "ChaosLights", candidateBody);
    assert.strictEqual(created.id, 201);
    assert.ok(candidateRequests.some((request) =>
        request.method === "POST" && request.endpoint === "repos/ChaosLights/lc/issues/8/comments",
    ));

    const refreshCalls = [];
    let requestAttempt = 0;
    const refreshCli = new githubCli.GitHubCli(
        async (forceRefresh) => {
            refreshCalls.push(forceRefresh);
            return accessToken;
        },
        async () => {
            requestAttempt++;
            if (requestAttempt === 1) {
                throw Object.assign(new Error("Bad credentials"), { status: 401 });
            }
            return { status: 200, data: { login: "ChaosLights" } };
        },
    );
    assert.strictEqual(await refreshCli.getLogin(), "ChaosLights");
    assert.deepStrictEqual(refreshCalls, [false, true]);

    console.log("githubCli tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
