#!/usr/bin/env node
// Twin of wc.js — written clean-room from observed behavior only.
// The author saw input/output pairs, never the original's source.
import { readFileSync } from "node:fs";

const data = readFileSync(0, "utf8");
let lines = 0;
let words = 0;
let inWord = false;
for (const ch of data) {
  if (ch === "\n") lines++;
  if (/\s/.test(ch)) {
    inWord = false;
  } else if (!inWord) {
    words++;
    inWord = true;
  }
}
if (data.length > 0 && !data.endsWith("\n")) lines++;
const bytes = Buffer.byteLength(data, "utf8");
console.log(`${lines} ${words} ${bytes}`);
