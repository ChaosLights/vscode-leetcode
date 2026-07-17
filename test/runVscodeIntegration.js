const path = require("path");
const { runTests } = require("@vscode/test-electron");

(async () => {
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
        ],
        version: "1.119.0",
    };
    if (process.env.VSCODE_EXECUTABLE_PATH) {
        options.vscodeExecutablePath = process.env.VSCODE_EXECUTABLE_PATH;
    }
    await runTests(options);
})().catch((error) => {
    console.error("VS Code integration tests failed", error);
    process.exitCode = 1;
});
