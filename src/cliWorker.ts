// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

import * as path from "path";
import { configureLegacyListCompatibility } from "./utils/legacyCliCompatibility";

// Run the bundled CLI inside a Node.js worker owned by the extension host.
// WorkerOptions.argv supplies the CLI arguments after this worker script.
const cliModulePath: string = path.join(__dirname, "..", "..", "node_modules", "vsc-leetcode-cli", "lib", "cli");
const cliRootPath: string = path.dirname(path.dirname(cliModulePath));
if (process.argv[2] === "list") {
    configureLegacyListCompatibility(
        cliRootPath,
        (message: string) => process.stderr.write(`[cli-worker] List compatibility: ${message}.\n`),
    );
}
// tslint:disable-next-line:no-var-requires
require(cliModulePath).run();
