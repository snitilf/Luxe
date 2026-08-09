import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { MERMAID_CDN_INTEGRITY, MERMAID_CDN_URL } from "../src/design-reference.js";

const FETCH_TIMEOUT_MS = 30_000;
const SHA384_INTEGRITY_PATTERN = /^sha384-[A-Za-z0-9+/]{64}$/;

export function sha384Integrity(bytes) {
  return `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
}

export async function verifyMermaidCdnIntegrity({
  fetchImpl = globalThis.fetch,
  url = MERMAID_CDN_URL,
  expectedIntegrity = MERMAID_CDN_INTEGRITY,
} = {}) {
  if (!SHA384_INTEGRITY_PATTERN.test(expectedIntegrity)) {
    throw new Error(`Invalid Mermaid SHA-384 integrity value: ${expectedIntegrity}`);
  }

  const response = await fetchImpl(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Could not verify Mermaid CDN integrity: ${url} returned HTTP ${response.status}.`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const actualIntegrity = sha384Integrity(bytes);
  if (actualIntegrity !== expectedIntegrity) {
    throw new Error(
      `Mermaid CDN integrity mismatch for ${url}.\n` +
        `Expected: ${expectedIntegrity}\n` +
        `Received: ${actualIntegrity}\n` +
        "Refusing to publish because artifacts would reject this CDN response.",
    );
  }

  return { url, integrity: actualIntegrity, bytes: bytes.byteLength };
}

async function main() {
  try {
    const result = await verifyMermaidCdnIntegrity();
    console.log(`Mermaid CDN integrity verified (${result.bytes} bytes): ${result.integrity}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (import.meta.url === entryUrl) await main();
