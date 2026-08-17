// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

const genericChallengeMessage: string =
    "Cloudflare blocked this LeetCode request. This response alone does not mean your login expired. " +
    "Retry later; if the same code consistently triggers it, make a behavior-preserving rewrite and try again.";

export function containsKnownPythonFloatDivisionPattern(sourceText: string | undefined): boolean {
    if (!sourceText) {
        return false;
    }
    const pattern: RegExp = /\bint\s*\(\s*float\s*\([^()\r\n]+\)\s*\/(?!\/)[^)\r\n]+\)/;
    return sourceText.split(/\r?\n/).some((line: string) => pattern.test(line.replace(/#.*$/, "")));
}

export function getCloudflareChallengeMessage(sourceText?: string, sourcePath?: string): string {
    if (!sourcePath || !/\.py$/i.test(sourcePath) || !containsKnownPythonFloatDivisionPattern(sourceText)) {
        return genericChallengeMessage;
    }

    return genericChallengeMessage +
        " This file contains a known Python false-positive pattern: an equivalent form such as " +
        "int(a * 1.0 / b) can avoid the challenge triggered by int(float(a)/b).";
}
