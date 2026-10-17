#!/usr/bin/env node
// Toy target for the FEA acceptance demo: a tiny adder CLI.
// Original: this file. Rebuild: reimplement from its synthesis context,
// then prove parity with `fea verify`.
const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  console.log("usage: adder <numbers...>");
  console.log("  prints the sum of its numeric arguments");
  process.exit(0);
}

const numbers = args.map(Number);
if (numbers.some((n) => Number.isNaN(n))) {
  console.error("adder: not a number");
  process.exit(1);
}

console.log(numbers.reduce((a, b) => a + b, 0));
