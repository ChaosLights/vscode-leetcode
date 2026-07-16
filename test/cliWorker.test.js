const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Worker } = require("worker_threads");
const {
    configureLegacyListCompatibility,
    parseLegacyCategoryProblems,
} = require("../out/src/utils/legacyCliCompatibility");
const { collectWorkerOutput } = require("../out/src/utils/workerUtils");

function runWorker(argv, home) {
    const worker = new Worker(path.resolve("out/src/cliWorker.js"), {
        argv,
        env: { ...process.env, HOME: home, NODE_NO_WARNINGS: "1" },
        stderr: true,
        stdout: true,
    });
    return collectWorkerOutput(worker).then(({ exitCode, stderr, stdout }) => ({ code: exitCode, stderr, stdout }));
}

(async () => {
    const parsedProblems = parseLegacyCategoryProblems({
        category_slug: "algorithms",
        stat_status_pairs: [{
            difficulty: { level: 2 },
            is_favor: true,
            paid_only: false,
            stat: {
                frontend_question_id: 42,
                question__hide: false,
                question__title: "Worker Compatibility",
                question__title_slug: "worker-compatibility",
                question_id: 4242,
                total_acs: 3,
                total_submitted: 4,
            },
            status: "ac",
        }],
        user_name: "",
    }, "https://leetcode.com/problems/$slug/description/", (level) => ["", "Easy", "Medium", "Hard"][level]);
    assert.strictEqual(parsedProblems.length, 1);
    assert.deepStrictEqual(parsedProblems[0], {
        category: "algorithms",
        fid: 42,
        id: 4242,
        level: "Medium",
        link: "https://leetcode.com/problems/worker-compatibility/description/",
        locked: false,
        name: "Worker Compatibility",
        percent: 75,
        slug: "worker-compatibility",
        starred: true,
        state: "ac",
    });

    const queueDiagnostics = [];
    const cliRoot = path.resolve("node_modules/vsc-leetcode-cli");
    configureLegacyListCompatibility(cliRoot, (message) => queueDiagnostics.push(message));
    const Queue = require(path.join(cliRoot, "lib", "queue"));
    const completedTasks = [];
    await new Promise((resolve, reject) => {
        const queue = new Queue(["first", "second", "third"], {}, (task, _queue, callback) => {
            setTimeout(() => {
                completedTasks.push(task);
                callback();
            }, 0);
        });
        queue.run(2, (error) => error ? reject(error) : resolve());
    });
    assert.deepStrictEqual(completedTasks.sort(), ["first", "second", "third"]);
    assert.ok(queueDiagnostics.some((line) => line === "queue start: tasks=3, concurrency=2"));
    assert.ok(queueDiagnostics.some((line) => line === "queue done: error=none"));

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

        const cachedProblems = Array.from({ length: 6000 }, (_, index) => ({
            category: "algorithms",
            fid: index + 1,
            id: index + 1,
            level: "Easy",
            link: `https://leetcode.com/problems/worker-output-${index + 1}/description/`,
            locked: false,
            name: `Worker Output ${index + 1}`,
            percent: 50,
            slug: `worker-output-${index + 1}`,
            starred: false,
            state: "None",
        }));
        fs.writeFileSync(problemCache, JSON.stringify(cachedProblems));
        fs.writeFileSync(
            path.join(path.dirname(problemCache), "translationConfig.json"),
            JSON.stringify({ useEndpointTranslation: true }),
        );
        const largeList = await runWorker(["list"], home);
        assert.strictEqual(largeList.code, 0);
        assert.ok(Buffer.byteLength(largeList.stdout) > 500000);
        assert.match(largeList.stdout, /Worker Output 6000/);
        assert.match(largeList.stdout, /Worker Output 1\s+Easy/);
        assert.match(largeList.stderr, /List compatibility: problem cache hit: count=6000/);
        console.log("CLI worker tests passed");
    } finally {
        fs.rmSync(home, { force: true, recursive: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
