#!/usr/bin/env node
// "Original" — a small word-count utility. Pretend this is closed source:
// the twin author never saw this file, only its behavior.
let data = "";
process.stdin.on("data", (c) => (data += c));
process.stdin.on("end", () => {
  const lines = data.length === 0 ? 0 : data.split("\n").length - (data.endsWith("\n") ? 1 : 0);
  const words = (data.match(/\S+/g) || []).length;
  const bytes = Buffer.byteLength(data, "utf8");
  console.log(`${lines} ${words} ${bytes}`);
});
