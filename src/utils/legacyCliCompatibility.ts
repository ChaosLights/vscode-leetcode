// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

import * as path from "path";

interface ILegacyQueue {
    concurrency: number;
    ctx: any;
    error: any;
    onDone?: (error: any, context: any) => void;
    onTask: (task: any, queue: ILegacyQueue, callback: (error?: any) => void) => void;
    tasks: any[];
    workerRun: () => void;
}

interface ILegacyQueueConstructor {
    prototype: ILegacyQueue & {
        run: (concurrency: number | undefined, onDone: (error: any, context: any) => void) => void;
    };
}

interface ILegacyProblem {
    category: string;
    fid: number;
    id: number;
    level: string;
    link: string;
    locked: boolean;
    name: string;
    percent: number;
    slug: string;
    starred: boolean;
    state: string;
}

function describeError(error: any): string {
    if (!error) {
        return "none";
    }
    return String(error.msg || error.message || error);
}

export function parseLegacyCategoryProblems(
    json: any,
    problemUrlTemplate: string,
    levelToName: (level: number) => string,
): ILegacyProblem[] {
    const pairs: any[] = Array.isArray(json.stat_status_pairs) ? json.stat_status_pairs : [];
    return pairs
        .filter((pair: any) => pair.stat && !pair.stat.question__hide)
        .map((pair: any): ILegacyProblem => ({
            category: String(json.category_slug || ""),
            fid: pair.stat.frontend_question_id,
            id: pair.stat.question_id,
            level: levelToName(pair.difficulty.level),
            link: problemUrlTemplate.replace("$slug", pair.stat.question__title_slug),
            locked: Boolean(pair.paid_only),
            name: pair.stat.question__title,
            percent: pair.stat.total_submitted > 0
                ? pair.stat.total_acs * 100 / pair.stat.total_submitted
                : 0,
            slug: pair.stat.question__title_slug,
            starred: Boolean(pair.is_favor),
            state: pair.status || "None",
        }));
}

// The legacy CLI starts its list request queue exclusively through setImmediate.
// Electron workers may finish after the synchronous command handler returns but
// before those callbacks establish their HTTP handles. Start and advance this
// four-category queue directly so its requests own the worker lifetime.
export function configureLegacyListCompatibility(
    cliRoot: string,
    diagnostic: (message: string) => void,
): void {
    const config: any = require(path.join(cliRoot, "lib", "config"));
    const helper: any = require(path.join(cliRoot, "lib", "helper"));
    const cache: any = require(path.join(cliRoot, "lib", "cache"));
    const Queue: ILegacyQueueConstructor = require(path.join(cliRoot, "lib", "queue"));
    const leetcodePlugin: any = require(path.join(cliRoot, "lib", "plugins", "leetcode"));
    // tslint:disable-next-line:no-var-requires
    const request: any = require("request");

    const originalCacheGet: (key: string) => any = cache.get.bind(cache);
    cache.get = (key: string): any => {
        const value: any = originalCacheGet(key);
        if (key === helper.KEYS.problems) {
            if (value === null) {
                diagnostic("problem cache miss");
            } else if (Array.isArray(value)) {
                diagnostic(`problem cache hit: count=${value.length}`);
            } else {
                diagnostic(`problem cache hit: unexpectedType=${typeof value}`);
            }
        }
        return value;
    };

    // The extension already validates the cookie with LeetCode's current
    // GraphQL user query. The old REST endpoint still returns a usable problem
    // list when its removed/empty user_name field makes the legacy CLI reject
    // the response as an expired session, so parse the list independently of
    // that obsolete field.
    leetcodePlugin.getCategoryProblems = (category: string, callback: (error: any, problems?: ILegacyProblem[]) => void): void => {
        const options: any = leetcodePlugin.makeOpts(config.sys.urls.problems.replace("$category", category));
        request(options, (requestError: any, response: any, body: string): void => {
            const error: any = leetcodePlugin.checkError(requestError, response, 200);
            if (error) {
                diagnostic(`category response: task=${category}, httpError=${describeError(error)}`);
                callback(error);
                return;
            }

            let json: any;
            try {
                json = JSON.parse(body);
            } catch (parseError) {
                diagnostic(
                    `category response: task=${category}, parseError=${describeError(parseError)}, ` +
                    `bodyBytes=${Buffer.byteLength(body || "", "utf8")}`,
                );
                callback({ msg: "invalid problem list response" });
                return;
            }
            const problems: ILegacyProblem[] = parseLegacyCategoryProblems(
                json,
                config.sys.urls.problem,
                helper.levelToName.bind(helper),
            );
            diagnostic(
                `category response: task=${category}, userNamePresent=${Boolean(json.user_name)}, ` +
                `problems=${problems.length}`,
            );
            callback(null, problems);
        });
    };

    Queue.prototype.run = function(
        this: ILegacyQueue,
        concurrency: number | undefined,
        onDone: (error: any, context: any) => void,
    ): void {
        this.concurrency = concurrency || config.network.concurrency || 1;
        this.onDone = onDone;
        const workerCount: number = this.concurrency;
        diagnostic(`queue start: tasks=${this.tasks.length}, concurrency=${workerCount}`);
        for (let index: number = 0; index < workerCount; ++index) {
            this.workerRun();
        }
    };

    Queue.prototype.workerRun = function(this: ILegacyQueue): void {
        if (this.tasks.length === 0) {
            this.concurrency--;
            if (this.concurrency === 0 && this.onDone) {
                diagnostic(`queue done: error=${describeError(this.error)}`);
                this.onDone(this.error, this.ctx);
            }
            return;
        }

        const task: any = this.tasks.shift();
        const taskName: string = String(task);
        this.onTask(task, this, (error?: any): void => {
            if (error) {
                this.error = error;
            }
            diagnostic(
                `queue task complete: task=${taskName}, remaining=${this.tasks.length}, error=${describeError(error)}`,
            );
            this.workerRun();
        });
    };
}
