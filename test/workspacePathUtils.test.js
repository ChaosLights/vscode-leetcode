const assert = require("assert");
const {
    resolveRemoteWorkspaceRelativePath,
    resolveUserWorkspaceFolder,
} = require("../out/src/utils/workspacePathUtils");
const { didCliLoginSucceed, inspectCliLoginOutput } = require("../out/src/utils/loginOutputUtils");
const { countCliProblems } = require("../out/src/utils/cliSessionUtils");

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

console.log("workspace path tests passed");
