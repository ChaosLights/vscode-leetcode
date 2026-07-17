// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

import sanitizeHtml = require("sanitize-html");

export function sanitizeProblemHtml(body: string): string {
    return sanitizeHtml(body, {
        allowedTags: sanitizeHtml.defaults.allowedTags.concat([
            "details",
            "summary",
            "img",
            "table",
            "thead",
            "tbody",
            "tfoot",
            "tr",
            "th",
            "td",
        ]),
        allowedAttributes: {
            "a": ["href", "name", "title"],
            "img": ["alt", "height", "src", "title", "width"],
            "th": ["colspan", "rowspan"],
            "td": ["colspan", "rowspan"],
            "*": ["class"],
        },
        allowedSchemes: ["http", "https"],
        allowProtocolRelative: false,
    });
}
