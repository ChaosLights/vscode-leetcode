// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const JSZip = require("jszip");

const baseVersion = "3.9.3";
const patchedVersion = "3.9.301";
const baseSha256 = "d8ad8b17b27ac9aa201d08ed03ad2a44bfe6d60e602ad0e5ed74783c1b447149";
const baseUrl =
    `https://marketplace.visualstudio.com/_apis/public/gallery/publishers/` +
    `pomdtr/vsextensions/excalidraw-editor/${baseVersion}/vspackage`;
const outputPath = path.resolve(
    __dirname,
    "..",
    `excalidraw-editor-pairing-${patchedVersion}.vsix`,
);
const fixedFileDate = new Date("2026-07-18T00:00:00.000Z");

async function download(url) {
    const response = await fetch(url, {
        headers: { "User-Agent": "vscode-leetcode-release-builder" },
        redirect: "follow",
    });
    if (!response.ok) {
        throw new Error(`Excalidraw Marketplace download failed with HTTP ${response.status}.`);
    }
    return Buffer.from(await response.arrayBuffer());
}

function sha256(content) {
    return crypto.createHash("sha256").update(content).digest("hex");
}

async function main() {
    const original = await download(baseUrl);
    const originalHash = sha256(original);
    if (originalHash !== baseSha256) {
        throw new Error(
            `Refusing to patch an unexpected Excalidraw VSIX: expected ${baseSha256}, got ${originalHash}.`,
        );
    }

    const archive = await JSZip.loadAsync(original);
    const packageEntry = archive.file("extension/package.json");
    const manifestEntry = archive.file("extension.vsixmanifest");
    if (!packageEntry || !manifestEntry) {
        throw new Error("The official Excalidraw VSIX is missing its manifest.");
    }

    const extensionPackage = JSON.parse(await packageEntry.async("string"));
    if (
        extensionPackage.publisher !== "pomdtr" ||
        extensionPackage.name !== "excalidraw-editor" ||
        extensionPackage.version !== baseVersion ||
        extensionPackage.browser !== "./dist/extension.js"
    ) {
        throw new Error("The official Excalidraw manifest no longer matches the audited 3.9.3 package.");
    }

    const commandIds = (extensionPackage.contributes.commands || []).map(
        (command) => command.command,
    );
    const customEditorIds = (extensionPackage.contributes.customEditors || []).map(
        (editor) => editor.viewType,
    );
    if (!commandIds.includes("excalidraw.showEditor") || !customEditorIds.includes("editor.excalidraw")) {
        throw new Error("The audited Excalidraw commands or custom editor are missing.");
    }

    extensionPackage.version = patchedVersion;
    extensionPackage.activationEvents = [
        ...new Set([
            ...(extensionPackage.activationEvents || []),
            ...customEditorIds.map((viewType) => `onCustomEditor:${viewType}`),
            ...commandIds.map((command) => `onCommand:${command}`),
        ]),
    ];
    delete extensionPackage.__metadata;

    const originalManifest = await manifestEntry.async("string");
    const identityPattern = new RegExp(
        `(Identity\\s+Language="en-US"\\s+Id="excalidraw-editor"\\s+Version=")${baseVersion.replace(/\./g, "\\.")}(")`,
    );
    if (!identityPattern.test(originalManifest)) {
        throw new Error("The Excalidraw VSIX identity could not be patched safely.");
    }
    const patchedManifest = originalManifest.replace(identityPattern, `$1${patchedVersion}$2`);

    archive.file(
        "extension/package.json",
        `${JSON.stringify(extensionPackage, null, 2)}\n`,
        { date: fixedFileDate },
    );
    archive.file("extension.vsixmanifest", patchedManifest, { date: fixedFileDate });
    for (const entry of Object.values(archive.files)) {
        entry.date = fixedFileDate;
    }
    const patched = await archive.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
        compressionOptions: { level: 9 },
    });
    fs.writeFileSync(outputPath, patched);
    console.log(`Packaged: ${path.basename(outputPath)} (${patched.length} bytes, sha256 ${sha256(patched)})`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
