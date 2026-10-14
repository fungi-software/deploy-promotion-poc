import assert from "node:assert/strict";
import { test } from "node:test";
import { greeting } from "./greeting.mjs";

test("greets by name", () => {
  assert.equal(greeting("agent"), "Hello, agent");
});
