const assert = require("assert");
const {
    resolveRemoteWorkspaceRelativePath,
    resolveUserWorkspaceFolder,
} = require("../out/src/utils/workspacePathUtils");
const { shouldUseElectronRunAsNodeFlag } = require("../out/src/utils/runtimeUtils");
const { inspectCliLoginOutput } = require("../out/src/utils/loginOutputUtils");

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

assert.strictEqual(shouldUseElectronRunAsNodeFlag("1.126.2"), true);
assert.strictEqual(shouldUseElectronRunAsNodeFlag("1.127.0"), false);
assert.strictEqual(shouldUseElectronRunAsNodeFlag("invalid"), false);

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

console.log("workspace path tests passed");
