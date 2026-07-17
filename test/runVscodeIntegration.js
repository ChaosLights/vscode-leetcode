const fs = require("fs");
const os = require("os");
const path = require("path");
const { runTests } = require("@vscode/test-electron");

(async () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vscode-leetcode-integration-"));
    const workspacePath = path.join(testRoot, "workspace");
    fs.mkdirSync(workspacePath);
    try {
        const options = {
            extensionDevelopmentPath: path.resolve(__dirname, ".."),
            extensionTestsPath: path.resolve(__dirname, "..", "out", "test", "vscodeIntegration.test.js"),
            extensionTestsEnv: {
                ...process.env,
                VSCODE_LEETCODE_TEST_MODE: "1",
            },
            launchArgs: [
                "--disable-extensions",
                "--disable-workspace-trust",
                "--skip-release-notes",
                "--skip-welcome",
                `--extensions-dir=${path.join(testRoot, "extensions")}`,
                `--user-data-dir=${path.join(testRoot, "user-data")}`,
                workspacePath,
            ],
            version: "1.119.0",
        };
        if (process.env.VSCODE_EXECUTABLE_PATH) {
            options.vscodeExecutablePath = process.env.VSCODE_EXECUTABLE_PATH;
        }
        await runTests(options);
    } finally {
        fs.rmSync(testRoot, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error("VS Code integration tests failed", error);
    process.exitCode = 1;
});
