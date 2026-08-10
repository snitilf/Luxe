import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { MERMAID_CDN_INTEGRITY, MERMAID_CDN_URL } from "../src/design-reference.js";
import { sha384Integrity, verifyMermaidCdnIntegrity } from "../scripts/verify-mermaid-cdn-integrity.js";

const encoder = new TextEncoder();

function responseFor(bytes, { status = 200 } = {}) {
  return new Response(bytes, { status });
}

test("sha384Integrity returns a browser-compatible SRI value", () => {
  const bytes = encoder.encode("known Mermaid module bytes");
  const expected = `sha384-${createHash("sha384").update(bytes).digest("base64")}`;

  assert.equal(sha384Integrity(bytes), expected);
});

test("the verifier fetches the declared Mermaid URL and accepts its exact bytes", async () => {
  const bytes = encoder.encode("export default { initialize() {} };");
  const expectedIntegrity = sha384Integrity(bytes);
  let requestedUrl = "";
  /** @type {RequestInit | undefined} */
  let requestedOptions;

  const result = await verifyMermaidCdnIntegrity({
    expectedIntegrity,
    fetchImpl: async (url, options) => {
      requestedUrl = String(url);
      requestedOptions = options;
      return responseFor(bytes);
    },
  });

  assert.equal(requestedUrl, MERMAID_CDN_URL);
  assert.equal(requestedOptions?.redirect, "follow");
  assert.ok(requestedOptions?.signal instanceof AbortSignal);
  assert.deepEqual(result, {
    url: MERMAID_CDN_URL,
    integrity: expectedIntegrity,
    bytes: bytes.byteLength,
  });
});

test("the verifier rejects bytes that do not match the pin", async () => {
  const bytes = encoder.encode("tampered module bytes");
  const actualIntegrity = sha384Integrity(bytes);

  await assert.rejects(
    () => verifyMermaidCdnIntegrity({ fetchImpl: async () => responseFor(bytes) }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Mermaid CDN integrity mismatch/);
      assert.match(error.message, new RegExp(MERMAID_CDN_INTEGRITY.replace(/[+]/g, "\\+")));
      assert.match(error.message, new RegExp(actualIntegrity.replace(/[+]/g, "\\+")));
      return true;
    },
  );
});

test("the verifier rejects an invalid pin before making a request", async () => {
  let fetched = false;

  await assert.rejects(
    () =>
      verifyMermaidCdnIntegrity({
        expectedIntegrity: "sha256-not-the-declared-algorithm",
        fetchImpl: async () => {
          fetched = true;
          return responseFor(encoder.encode("unused"));
        },
      }),
    /Invalid Mermaid SHA-384 integrity value/,
  );
  assert.equal(fetched, false);
});

test("the verifier rejects an unsuccessful CDN response", async () => {
  const response = responseFor(encoder.encode("unavailable"), { status: 503 });

  await assert.rejects(() => verifyMermaidCdnIntegrity({ fetchImpl: async () => response }), /returned HTTP 503/);
});
