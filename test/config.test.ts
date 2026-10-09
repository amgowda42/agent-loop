import assert from "node:assert/strict";
import test from "node:test";

import { loadEnv } from "../src/config";

test("loads configuration from the root .env file", () => {
  const provider = loadEnv();
  assert.equal(provider, "openai");
  assert.equal(
    process.env.LLM_BASE_URL,
    "https://generativelanguage.googleapis.com/v1beta/openai",
  );
});

test("prefers the active environment provider over missing .env values", () => {
  const previousProvider = process.env.PROVIDER;
  process.env.PROVIDER = "anthropic";

  try {
    assert.equal(loadEnv(), "anthropic");
  } finally {
    if (previousProvider === undefined) delete process.env.PROVIDER;
    else process.env.PROVIDER = previousProvider;
  }
});
