// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

import * as path from "path";

// Run the bundled CLI inside a Node.js worker owned by the extension host.
// WorkerOptions.argv supplies the CLI arguments after this worker script.
const cliModulePath: string = path.join(__dirname, "..", "..", "node_modules", "vsc-leetcode-cli", "lib", "cli");
// tslint:disable-next-line:no-var-requires
require(cliModulePath).run();
