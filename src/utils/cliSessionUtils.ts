// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

export function countCliProblems(output: string): number {
    const problemPattern: RegExp = /^(.)\s(.{1,2})\s(.)\s\[\s*(\d*)\s*\]\s*(.*)\s*(Easy|Medium|Hard)\s*\((\s*\d+\.\d+ %)\)/;
    return output.split("\n").filter((line: string) => problemPattern.test(line)).length;
}
