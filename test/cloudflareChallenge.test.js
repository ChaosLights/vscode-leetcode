const assert = require("assert");
const {
    containsKnownPythonFloatDivisionPattern,
    getCloudflareChallengeMessage,
} = require("../out/src/utils/cloudflareChallenge");

assert.strictEqual(containsKnownPythonFloatDivisionPattern("return int(float(a)/b)"), true);
assert.strictEqual(containsKnownPythonFloatDivisionPattern("return int( float(total) / count )"), true);
assert.strictEqual(containsKnownPythonFloatDivisionPattern("return int(a * 1.0 / b)"), false);
assert.strictEqual(containsKnownPythonFloatDivisionPattern("return int(float(a)//b)"), false);
assert.strictEqual(containsKnownPythonFloatDivisionPattern("# return int(float(a)/b)"), false);
assert.strictEqual(containsKnownPythonFloatDivisionPattern(undefined), false);

const genericMessage = getCloudflareChallengeMessage("return value", "/tmp/solution.py");
assert.match(genericMessage, /does not mean your login expired/i);
assert.doesNotMatch(genericMessage, /login is still valid/i);
assert.doesNotMatch(genericMessage, /int\(float/);

const nonPythonMessage = getCloudflareChallengeMessage("return int(float(a)/b)", "/tmp/solution.cpp");
assert.doesNotMatch(nonPythonMessage, /known Python false-positive pattern/i);

const pythonMessage = getCloudflareChallengeMessage("return int(float(a)/b)", "/tmp/solution.py");
assert.match(pythonMessage, /known Python false-positive pattern/i);
assert.match(pythonMessage, /int\(a \* 1\.0 \/ b\)/);

console.log("Cloudflare challenge message tests passed");
