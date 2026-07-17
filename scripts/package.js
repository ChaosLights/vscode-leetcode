// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

"use strict";

const childProcess = require("child_process");
const path = require("path");
const packageJson = require("../package.json");

const repositoryRoot = path.resolve(__dirname, "..");
const outputFile = `vscode-leetcode-live-share-${packageJson.version}.vsix`;
const npmCli = process.env.npm_execpath;
if (!npmCli) {
    throw new Error("Run this package helper through npm so the pinned VSCE tool can be resolved.");
}
const result = childProcess.spawnSync(
    process.execPath,
    [
        npmCli,
        "exec",
        "--yes",
        "--package=@vscode/vsce@3.9.1",
        "--",
        "vsce",
        "package",
        "--out",
        outputFile,
    ],
    {
        cwd: repositoryRoot,
        stdio: "inherit",
    },
);

if (result.error) {
    throw result.error;
}
process.exit(result.status === null ? 1 : result.status);
