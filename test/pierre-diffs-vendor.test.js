import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  PIERRE_DIFFS_ASSET_FILE,
  PIERRE_DIFFS_GLOBAL,
  PIERRE_DIFFS_MAX_BYTES,
  PIERRE_DIFFS_SHA384,
  PIERRE_DIFFS_VERSION,
} from "../src/pierre-diffs-vendor.js";

test("the browser code-review bundle is exact, classic, and small enough to export", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const asset = await readFile(new URL(`../dist/design/${PIERRE_DIFFS_ASSET_FILE}`, import.meta.url));
  const source = asset.toString("utf8");
  const digest = `sha384-${createHash("sha384").update(asset).digest("base64")}`;

  assert.equal(packageJson.devDependencies["@pierre/diffs"], PIERRE_DIFFS_VERSION);
  assert.equal(digest, PIERRE_DIFFS_SHA384);
  assert.ok(asset.length <= PIERRE_DIFFS_MAX_BYTES, `${PIERRE_DIFFS_ASSET_FILE} exceeds the export cap`);
  assert.match(source, new RegExp(`^var ${PIERRE_DIFFS_GLOBAL}=`));
  assert.doesNotMatch(source, /^\s*(?:import|export)\s/m, "the exportable asset must not need a module graph");
});
