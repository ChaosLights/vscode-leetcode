const assert = require("assert");
const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const cliPath = path.resolve("node_modules/vsc-leetcode-cli/bin/leetcode");

function runCli(argv, home) {
    return new Promise((resolve, reject) => {
        const child = cp.spawn(process.execPath, [cliPath, ...argv], {
            env: { ...process.env, HOME: home, USERPROFILE: home, NODE_NO_WARNINGS: "1" },
            shell: false,
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (data) => stdout += data.toString());
        child.stderr.on("data", (data) => stderr += data.toString());
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stderr, stdout }));
    });
}

(async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vscode-leetcode-process-"));
    try {
        const help = await runCli(["--help"], home);
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
            cookie: "LEETCODE_SESSION=fake-session; csrftoken=fake-csrf;",
            login: "process-test-user",
            name: "process-test-user",
            paid: false,
            sessionCSRF: "fake-csrf",
            sessionId: "fake-session",
        }));

        const user = await runCli(["user"], home);
        assert.strictEqual(user.code, 0);
        assert.match(user.stdout, /process-test-user/);
        assert.strictEqual(user.stderr, "");

        const problemCache = path.join(leetCodeHome, "leetcode", "cache", "problems.json");
        fs.mkdirSync(path.dirname(problemCache), { recursive: true });
        fs.writeFileSync(problemCache, "[]");
        const deleteCache = await runCli(["cache", "-d"], home);
        assert.strictEqual(deleteCache.code, 0);
        assert.strictEqual(fs.existsSync(problemCache), false);

        const cachedProblems = Array.from({ length: 6000 }, (_, index) => ({
            category: "algorithms",
            fid: index + 1,
            id: index + 1,
            level: "Easy",
            link: `https://leetcode.com/problems/process-output-${index + 1}/description/`,
            locked: false,
            name: `Process Output ${index + 1}`,
            percent: 50,
            slug: `process-output-${index + 1}`,
            starred: false,
            state: "None",
        }));
        fs.writeFileSync(problemCache, JSON.stringify(cachedProblems));
        fs.writeFileSync(
            path.join(path.dirname(problemCache), "translationConfig.json"),
            JSON.stringify({ useEndpointTranslation: true }),
        );
        const largeList = await runCli(["list"], home);
        assert.strictEqual(largeList.code, 0);
        assert.ok(Buffer.byteLength(largeList.stdout) > 500000);
        assert.match(largeList.stdout, /Process Output 6000/);
        assert.match(largeList.stdout, /Process Output 1\s+Easy/);
        console.log("CLI external process tests passed");
    } finally {
        fs.rmSync(home, { force: true, recursive: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
