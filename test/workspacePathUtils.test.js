const assert = require("assert");
const {
    getSafeTempFileExtension,
    resolveRemoteWorkspaceRelativePath,
    resolveUserWorkspaceFolder,
} = require("../out/src/utils/workspacePathUtils");
const {
    determineCliLoginOutputAction,
    didCliLoginSucceed,
    inspectCliLoginOutput,
} = require("../out/src/utils/loginOutputUtils");
const { countCliProblems } = require("../out/src/utils/cliSessionUtils");
const { prepareTestCaseArgument } = require("../out/src/utils/testCaseUtils");
const { KeyedOperationLock } = require("../out/src/utils/operationLock");
const { sanitizeProblemHtml } = require("../out/src/utils/problemHtmlUtils");

assert.strictEqual(
    resolveUserWorkspaceFolder({ wucan: "code/wucan", wangchu: "code/wangchu" }, "wucan", "ignored"),
    "code/wucan",
);
assert.strictEqual(resolveUserWorkspaceFolder({}, "wucan", "/workspaces/lc"), "/workspaces/lc");
assert.throws(
    () => resolveUserWorkspaceFolder({ wucan: "code/wucan" }, "someone-else", ""),
    /No LeetCode workspace folder/,
);

assert.strictEqual(resolveRemoteWorkspaceRelativePath("code/wucan", "/workspaces/lc", "lc", false), "code/wucan");
assert.strictEqual(resolveRemoteWorkspaceRelativePath("/workspaces/lc", "/workspaces/lc", "lc", false), "");
assert.strictEqual(
    resolveRemoteWorkspaceRelativePath("/workspaces/lc/code/wucan", "/workspaces/lc", "lc", false),
    "code/wucan",
);
assert.strictEqual(
    resolveRemoteWorkspaceRelativePath("/workspaces/lc/code/wangchu", "/~0", "lc", true),
    "code/wangchu",
);
assert.strictEqual(resolveRemoteWorkspaceRelativePath("/workspaces/other", "/workspaces/lc", "lc", false), undefined);
assert.strictEqual(resolveRemoteWorkspaceRelativePath("../outside", "/workspaces/lc", "lc", false), undefined);
assert.strictEqual(getSafeTempFileExtension("/~0/code/user/1.two-sum.cpp"), ".cpp");
assert.strictEqual(getSafeTempFileExtension("/~0/code/user/solution.PY"), ".PY");
assert.strictEqual(getSafeTempFileExtension("/~0/code/user/solution.cpp:secret"), ".txt");
assert.strictEqual(getSafeTempFileExtension("/~0/code/user/solution.very-long-extension"), ".txt");

assert.deepStrictEqual(inspectCliLoginOutput("login: "), {
    failed: false,
    requestsCookie: false,
    requestsLogin: true,
    succeeded: false,
});
assert.deepStrictEqual(inspectCliLoginOutput("login: wangchu\ncookie: "), {
    failed: false,
    requestsCookie: true,
    requestsLogin: true,
    succeeded: false,
});
assert.strictEqual(
    inspectCliLoginOutput("Successfully cookie login" + " as wangchu").succeeded,
    true,
);
assert.strictEqual(inspectCliLoginOutput("[ERROR] session expired").failed, true);
assert.strictEqual(
    determineCliLoginOutputAction(
        inspectCliLoginOutput("login: wangchu\ncookie: value\nSuccessfully cookie login as wangchu"),
        true,
        true,
    ),
    "succeed",
);
assert.strictEqual(
    determineCliLoginOutputAction(
        inspectCliLoginOutput("login: wangchu\ncookie: value\nSuccessfully cookie login as wangchu"),
        false,
        false,
    ),
    "succeed",
);
assert.strictEqual(
    determineCliLoginOutputAction(inspectCliLoginOutput("login: "), false, false),
    "sendLogin",
);
assert.strictEqual(
    determineCliLoginOutputAction(inspectCliLoginOutput("login: wangchu\ncookie: "), true, false),
    "sendCookie",
);
assert.strictEqual(
    determineCliLoginOutputAction(
        inspectCliLoginOutput("Successfully cookie login as wangchu\n[ERROR] rejected"),
        true,
        true,
    ),
    "fail",
);
assert.strictEqual(
    didCliLoginSucceed(0, inspectCliLoginOutput("login: user\ncookie: ")),
    false,
);
assert.strictEqual(
    didCliLoginSucceed(0, inspectCliLoginOutput("Successfully cookie login as user")),
    true,
);
assert.strictEqual(
    didCliLoginSucceed(0, inspectCliLoginOutput("cookie: \n[ERROR] rejected")),
    false,
);
assert.strictEqual(
    countCliProblems("    v [   1 ] Two Sum Easy (55.00 %)\n      [   2 ] Add Two Numbers Medium (45.00 %)\n"),
    2,
);
assert.strictEqual(prepareTestCaseArgument("[1,2]\r\n3"), "[1,2]\n3");
assert.strictEqual(prepareTestCaseArgument("a \"quoted\" value"), "a \"quoted\" value");
assert.ok(!prepareTestCaseArgument("[1,2]\\n3").startsWith("'"));

const operationLock = new KeyedOperationLock();
const testLease = operationLock.acquire("vsls:/solution.cpp", "test");
assert.ok(testLease);
assert.strictEqual(operationLock.getActiveOperation("vsls:/solution.cpp"), "test");
assert.strictEqual(operationLock.acquire("vsls:/solution.cpp", "submit"), undefined);
testLease.release();
testLease.release();
assert.ok(operationLock.acquire("vsls:/solution.cpp", "submit"));

const sanitizedProblem = sanitizeProblemHtml(
    '<p class="example">safe</p><img src="https://example.com/a.png" onerror="alert(1)">' +
    '<script>alert(1)</script><a href="javascript:alert(1)">bad</a>',
);
assert.match(sanitizedProblem, /class="example"/);
assert.match(sanitizedProblem, /https:\/\/example\.com\/a\.png/);
assert.doesNotMatch(sanitizedProblem, /onerror|<script|javascript:/i);

console.log("workspace path tests passed");
