const assert = require("assert");
const fs = require("fs");
const path = require("path");

const pluginPath = path.resolve("node_modules/vsc-leetcode-cli/lib/plugins/leetcode.js");
const source = fs.readFileSync(pluginPath, "utf8");

assert.match(source, /vscode-leetcode-cloudflare-classification/);
assert.match(source, /Cloudflare security challenge blocked this code payload/);
assert.match(source, /plugin\.checkError = function\(e, resp, expectedStatus, body\)/);
assert.strictEqual(
    (source.match(/plugin\.checkError\(e, resp, 200, body\)/g) || []).length,
    11,
);
assert.doesNotMatch(source, /plugin\.checkError\(e, resp, 200\);/);

console.log("bundled CLI patch tests passed");
