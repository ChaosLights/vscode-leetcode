"use strict";

const assert = require("assert");
const packageJson = require("../package.json");

const contributedCommands = new Set(
    (packageJson.contributes.commands || []).map((contribution) => contribution.command),
);
const explicitlyActivatedCommands = new Set(
    (packageJson.activationEvents || [])
        .filter((event) => event.startsWith("onCommand:"))
        .map((event) => event.substring("onCommand:".length)),
);

assert.deepStrictEqual(
    [...contributedCommands].filter((command) => !explicitlyActivatedCommands.has(command)),
    [],
    "Every contributed command must have an explicit activation event for restored Remote/Live Share UI.",
);
assert.deepStrictEqual(
    [...explicitlyActivatedCommands].filter((command) => !contributedCommands.has(command)),
    [],
    "Every command activation event must refer to a contributed command.",
);

console.log("package manifest tests passed");
