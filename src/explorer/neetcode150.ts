// Copyright (c) LeetCode. All rights reserved.
// Licensed under the MIT license.

export interface INeetCode150Category {
    name: string;
    problemIds: string[];
}

// Snapshot of https://neetcode.io/practice/practice/neetcode150 from 2026-07-15.
// Only LeetCode problem IDs are stored; problem content still comes from LeetCode.
export const NEETCODE_150_CATEGORIES: INeetCode150Category[] = [
    {
        name: "Arrays & Hashing",
        problemIds: ["217", "242", "1", "49", "347", "271", "238", "36", "128"],
    },
    {
        name: "Two Pointers",
        problemIds: ["125", "167", "15", "11", "42"],
    },
    {
        name: "Sliding Window",
        problemIds: ["121", "3", "424", "567", "76", "239"],
    },
    {
        name: "Stack",
        problemIds: ["20", "155", "150", "739", "853", "84"],
    },
    {
        name: "Binary Search",
        problemIds: ["704", "74", "875", "153", "33", "981", "4"],
    },
    {
        name: "Linked List",
        problemIds: ["206", "21", "141", "143", "19", "138", "2", "287", "146", "23", "25"],
    },
    {
        name: "Trees",
        problemIds: ["226", "104", "543", "110", "100", "572", "235", "102", "199", "1448", "98", "230", "105", "124", "297"],
    },
    {
        name: "Heap / Priority Queue",
        problemIds: ["703", "1046", "973", "215", "621", "355", "295"],
    },
    {
        name: "Backtracking",
        problemIds: ["78", "39", "40", "46", "90", "22", "79", "131", "17", "51"],
    },
    {
        name: "Tries",
        problemIds: ["208", "211", "212"],
    },
    {
        name: "Graphs",
        problemIds: ["200", "695", "133", "286", "994", "417", "130", "207", "210", "261", "323", "684", "127"],
    },
    {
        name: "Advanced Graphs",
        problemIds: ["743", "332", "1584", "778", "269", "787"],
    },
    {
        name: "1-D Dynamic Programming",
        problemIds: ["70", "746", "198", "213", "5", "647", "91", "322", "152", "139", "300", "416"],
    },
    {
        name: "2-D Dynamic Programming",
        problemIds: ["62", "1143", "309", "518", "494", "97", "329", "115", "72", "312", "10"],
    },
    {
        name: "Greedy",
        problemIds: ["53", "55", "45", "134", "846", "1899", "763", "678"],
    },
    {
        name: "Intervals",
        problemIds: ["57", "56", "435", "252", "253", "1851"],
    },
    {
        name: "Math & Geometry",
        problemIds: ["48", "54", "73", "202", "66", "50", "43", "2013"],
    },
    {
        name: "Bit Manipulation",
        problemIds: ["136", "191", "338", "190", "268", "371", "7"],
    },
];
