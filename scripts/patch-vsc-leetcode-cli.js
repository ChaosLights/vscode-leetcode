// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

"use strict";

const fs = require("fs");
const path = require("path");

const cliPluginPath = path.resolve(
    __dirname,
    "..",
    "node_modules",
    "vsc-leetcode-cli",
    "lib",
    "plugins",
    "leetcode.js",
);
const marker = "vscode-leetcode-cloudflare-classification";
let source = fs.readFileSync(cliPluginPath, "utf8");

if (source.includes(marker)) {
    process.exit(0);
}

const originalCheckError = `plugin.checkError = function(e, resp, expectedStatus) {
  if (!e && resp && resp.statusCode !== expectedStatus) {
    const code = resp.statusCode;
    log.debug('http error: ' + code);

    if (code === 403 || code === 401) {
      e = session.errors.EXPIRED;
    } else {
      e = {msg: 'http error', statusCode: code};
    }
  }
  return e;
};`;

const patchedCheckError = `plugin.checkError = function(e, resp, expectedStatus, body) {
  if (!e && resp && resp.statusCode !== expectedStatus) {
    const code = resp.statusCode;
    log.debug('http error: ' + code);

    // vscode-leetcode-cloudflare-classification: Cloudflare can return a
    // managed HTML challenge for particular source-code payloads. It is not
    // an expired LeetCode cookie and must not trigger a login-repair loop.
    const contentType = String((resp.headers || {})['content-type'] || '');
    const server = String((resp.headers || {}).server || '');
    const responseText = typeof body === 'string' ? body : '';
    const isCloudflareChallenge = code === 403 &&
      (/cloudflare/i.test(server) || Boolean((resp.headers || {})['cf-ray'])) &&
      /text\\/html/i.test(contentType) &&
      (/<title>\\s*Just a moment/i.test(responseText) ||
        /challenge-platform|Enable JavaScript and cookies/i.test(responseText));

    if (isCloudflareChallenge) {
      e = {
        msg: 'Cloudflare security challenge blocked this code payload; the LeetCode session is still valid. ' +
          'Rewrite the flagged expression without changing its behavior and retry. For Python division, ' +
          'int(a * 1.0 / b) avoids a known false positive from int(float(a)/b).',
        statusCode: 403
      };
    } else if (code === 403 || code === 401) {
      e = session.errors.EXPIRED;
    } else {
      e = {msg: 'http error', statusCode: code};
    }
  }
  return e;
};`;

if (!source.includes(originalCheckError)) {
    throw new Error("The bundled vsc-leetcode-cli checkError implementation changed; refusing an unsafe patch.");
}
source = source.replace(originalCheckError, patchedCheckError);

const originalCall = "e = plugin.checkError(e, resp, 200);";
const patchedCall = "e = plugin.checkError(e, resp, 200, body);";
const callCount = source.split(originalCall).length - 1;
if (callCount !== 11) {
    throw new Error(`Expected 11 vsc-leetcode-cli response checks, found ${callCount}.`);
}
source = source.split(originalCall).join(patchedCall);
fs.writeFileSync(cliPluginPath, source, "utf8");
console.log("Patched vsc-leetcode-cli Cloudflare challenge classification.");
