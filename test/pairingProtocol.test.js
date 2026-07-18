"use strict";

const assert = require("assert");
const protocol = require("../out/src/pairing/pairingProtocol");

const now = Date.parse("2026-07-18T03:20:00.000Z");
const state = {
    version: 1,
    generation: 4,
    status: "ready",
    updatedAt: "2026-07-18T03:19:00.000Z",
    leaseExpiresAt: "2026-07-18T03:21:00.000Z",
    hostLogin: "ChaosLights",
    hostNonce: "0123456789abcdef0123456789abcdef",
    codespaceName: "effective-fishstick-g99rxrx9xrgfv9v5",
    joinUrl: "https://prod.liveshare.vsengsaas.visualstudio.com/join?example",
    error: null,
};

const rendered = protocol.renderPairingIssueBody(state);
assert.deepStrictEqual(protocol.parsePairingState(rendered), state);
assert.strictEqual(protocol.isLeaseActive(state, now), true);
assert.strictEqual(protocol.isLeaseActive(state, Date.parse("2026-07-18T03:22:00.000Z")), false);
const startingState = {
    ...state,
    status: "starting",
    joinUrl: null,
};
assert.strictEqual(protocol.canRetryCodespaceOpen(
    startingState, 4, "ChaosLights", "effective-fishstick-g99rxrx9xrgfv9v5", now,
), true);
assert.strictEqual(protocol.canRetryCodespaceOpen(
    startingState, 4, "another-user", "effective-fishstick-g99rxrx9xrgfv9v5", now,
), false);
assert.strictEqual(protocol.canRetryCodespaceOpen(
    startingState, 4, "ChaosLights", "another-codespace", now,
), false);
assert.strictEqual(protocol.canRetryCodespaceOpen(
    startingState, 4, "ChaosLights", "effective-fishstick-g99rxrx9xrgfv9v5", Date.parse("2026-07-18T03:22:00.000Z"),
), false);

const first = {
    version: 1,
    generation: 5,
    login: "first-user",
    nonce: "11111111111111111111111111111111",
    createdAt: "2026-07-18T03:19:58.000Z",
};
const second = {
    version: 1,
    generation: 5,
    login: "second-user",
    nonce: "22222222222222222222222222222222",
    createdAt: "2026-07-18T03:19:59.000Z",
};
const comments = [
    { id: 902, createdAt: second.createdAt, body: protocol.renderCandidateComment(second) },
    { id: 901, createdAt: first.createdAt, body: protocol.renderCandidateComment(first) },
    {
        id: 1,
        createdAt: "2026-07-18T03:00:00.000Z",
        body: protocol.renderCandidateComment({ ...first, nonce: "33333333333333333333333333333333" }),
    },
    { id: 3, createdAt: first.createdAt, body: "not a candidate" },
];
const winner = protocol.chooseElectionWinner(comments, 5, now, 45_000);
assert.ok(winner);
assert.strictEqual(winner.commentId, 901);
assert.strictEqual(winner.candidate.login, "first-user");
assert.strictEqual(protocol.chooseElectionWinner(comments, 6, now, 45_000), undefined);

assert.deepStrictEqual(protocol.validatePairingTarget({
    repository: "ChaosLights/lc",
    issueNumber: 8,
    branch: "main",
}), { repository: "ChaosLights/lc", issueNumber: 8, branch: "main" });
assert.throws(() => protocol.validatePairingTarget({
    repository: "ChaosLights/lc/extra",
    issueNumber: 8,
    branch: "main",
}));
assert.strictEqual(protocol.isAllowedLiveShareUrl(state.joinUrl), true);
assert.strictEqual(protocol.isAllowedLiveShareUrl("https://example.com/steal"), false);
assert.strictEqual(protocol.isAllowedLiveShareUrl("javascript:alert(1)"), false);

console.log("pairingProtocol tests passed");
