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
    console.log("githubCli tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
