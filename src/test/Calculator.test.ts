import assert from "node:assert";
import { Calculator } from "../Calculator";

const calc = new Calculator();

// add
assert.strictEqual(calc.add(2, 3), 5);
assert.strictEqual(calc.add(-1, 1), 0);
assert.strictEqual(calc.add(0, 0), 0);

// subtract
assert.strictEqual(calc.subtract(5, 3), 2);
assert.strictEqual(calc.subtract(0, 5), -5);
assert.strictEqual(calc.subtract(-3, -7), 4);

// multiply
assert.strictEqual(calc.multiply(3, 4), 12);
assert.strictEqual(calc.multiply(-2, 3), -6);
assert.strictEqual(calc.multiply(0, 100), 0);

// divide
assert.strictEqual(calc.divide(10, 2), 5);
assert.strictEqual(calc.divide(-6, 3), -2);
assert.strictEqual(calc.divide(7, 2), 3.5);
assert.throws(() => calc.divide(1, 0), {
  message: "Cannot divide by zero",
});

console.log("All tests passed.");
