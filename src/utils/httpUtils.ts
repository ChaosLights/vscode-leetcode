import axios, { AxiosRequestConfig, AxiosPromise } from "axios";
import { omit } from "lodash";
import { globalState } from "../globalState";
import { DialogType, promptForOpenOutputChannel } from "./uiUtils";

const referer = "vscode-lc-extension";

export function LcAxios<T = any>(path: string, settings?: AxiosRequestConfig, cookieOverride?: string): AxiosPromise<T> {
    const requestUrl: URL = new URL(path);
    if (
        requestUrl.protocol !== "https:" ||
        (requestUrl.hostname !== "leetcode.com" && requestUrl.hostname !== "leetcode.cn")
    ) {
        return Promise.reject(new Error("Refusing to send LeetCode credentials to an unexpected URL."));
    }
    const cookie = cookieOverride || globalState.getCookie();
    if (!cookie) {
        promptForOpenOutputChannel(
            `Failed to obtain the cookie. Please log in again.`,
            DialogType.error
        );
        return Promise.reject("Failed to obtain the cookie.");
    }
    return axios(path, {
        headers: {
            referer,
            "content-type": "application/json",
            cookie,
            ...(settings && settings.headers),
        },
        xsrfCookieName: "csrftoken",
        xsrfHeaderName: "X-CSRFToken",
        ...(settings && omit(settings, "headers")),
        timeout: 30000,
        maxBodyLength: 1024 * 1024,
        maxContentLength: 10 * 1024 * 1024,
    });
}
