const fs = require("fs");
const os = require("os");
const path = require("path");
const { runTests } = require("@vscode/test-electron");

async function removeTestRoot(testRoot) {
    let lastError;
    for (let attempt = 0; attempt < 40; attempt++) {
        try {
            fs.rmSync(testRoot, { recursive: true, force: true });
            return;
        } catch (error) {
            if (!["EBUSY", "ENOTEMPTY", "EPERM"].includes(error.code)) {
                throw error;
            }
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }
    // The integration result is authoritative. A delayed Electron handle on a
    // disposable OS-temp profile must not convert a passing suite into a test
    // failure; the next OS temp cleanup can remove the directory.
    console.warn(`Unable to remove temporary VS Code profile '${testRoot}': ${lastError}`);
}

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
        await removeTestRoot(testRoot);
    }
})().catch((error) => {
    console.error("VS Code integration tests failed", error);
    process.exitCode = 1;
});
