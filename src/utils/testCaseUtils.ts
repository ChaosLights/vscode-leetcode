// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

export function prepareTestCaseArgument(input: string): string {
    return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
