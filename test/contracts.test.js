import test from "node:test";
import assert from "node:assert/strict";
import { ResourceKind, RouteCondition, normalizeQuota } from "../src/index.js";

test("采收份额不接受小数", () => {
  assert.throws(() => normalizeQuota(1.5), /非负整数/);
});

test("航线关闭值保持稳定", () => {
  assert.equal(RouteCondition.CLOSED, "closed");
  assert.equal(ResourceKind.BOAT, "boat");
});
