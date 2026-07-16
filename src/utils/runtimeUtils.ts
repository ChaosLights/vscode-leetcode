// Copyright (c) jdneo. All rights reserved.
// Licensed under the MIT license.

export function shouldUseElectronRunAsNodeFlag(version: string): boolean {
    const match: RegExpMatchArray | null = version.match(/^(\d+)\.(\d+)/);
    if (!match) {
        return false;
    }
    const major: number = Number(match[1]);
    const minor: number = Number(match[2]);
    return major === 1 && minor >= 62 && minor < 127;
}
