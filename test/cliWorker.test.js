const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Worker } = require("worker_threads");

function runWorker(argv, home) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(path.resolve("out/src/cliWorker.js"), {
            argv,
            env: { ...process.env, HOME: home, NODE_NO_WARNINGS: "1" },
            stderr: true,
            stdout: true,
        });
        let stdout = "";
        let stderr = "";
        worker.stdout.on("data", (data) => stdout += data.toString());
        worker.stderr.on("data", (data) => stderr += data.toString());
        worker.on("error", reject);
        worker.on("exit", (code) => resolve({ code, stderr, stdout }));
    });
}

(async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vscode-leetcode-worker-"));
    try {
        const help = await runWorker(["--help"], home);
        assert.strictEqual(help.code, 0);
        assert.match(help.stdout, /Commands:/);
        assert.match(help.stdout, /leetcode/);

        const leetCodeHome = path.join(home, ".lc");
        fs.mkdirSync(path.join(leetCodeHome, "leetcode"), { recursive: true });
        fs.writeFileSync(path.join(leetCodeHome, "plugins.json"), JSON.stringify({
            cache: true,
            company: false,
            "leetcode.cn": false,
            leetcode: true,
            retry: true,
            "solution.discuss": false,
        }));
        fs.writeFileSync(path.join(leetCodeHome, "leetcode", "user.json"), JSON.stringify({
            login: "worker-test-user",
            name: "worker-test-user",
            paid: false,
            sessionCSRF: "fake-csrf",
            sessionId: "fake-session",
        }));

        const user = await runWorker(["user"], home);
        assert.strictEqual(user.code, 0);
        assert.match(user.stdout, /worker-test-user/);
        assert.strictEqual(user.stderr, "");

        const problemCache = path.join(leetCodeHome, "leetcode", "cache", "problems.json");
        fs.mkdirSync(path.dirname(problemCache), { recursive: true });
        fs.writeFileSync(problemCache, "[]");
        const deleteCache = await runWorker(["cache", "-d"], home);
        assert.strictEqual(deleteCache.code, 0);
        assert.strictEqual(fs.existsSync(problemCache), false);
        console.log("CLI worker tests passed");
    } finally {
        fs.rmSync(home, { force: true, recursive: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
