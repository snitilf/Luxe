import assert from "node:assert/strict";
import test from "node:test";

import {
  bindHost,
  clientHost,
  extraAllowedHosts,
  hostForUrl,
  IPV6_LOOPBACK_HOST,
  isLoopbackHost,
  LOOPBACK_HOST,
  linkHost,
  remoteBindingAllowed,
} from "../src/paths.js";

test("bindHost defaults to loopback and honors LUXE_HOST", () => {
  assert.equal(bindHost({}), LOOPBACK_HOST);
  assert.equal(bindHost({ LUXE_HOST: "" }), LOOPBACK_HOST);
  assert.equal(bindHost({ LUXE_HOST: "  " }), LOOPBACK_HOST);
  assert.equal(bindHost({ LUXE_HOST: "100.64.0.1" }), "100.64.0.1");
  assert.equal(bindHost({ LUXE_HOST: " 0.0.0.0 " }), "0.0.0.0");
});

test("clientHost dials the bind host but falls back to the matching-family loopback for wildcard binds", () => {
  assert.equal(clientHost({}), LOOPBACK_HOST);
  assert.equal(clientHost({ LUXE_HOST: "100.64.0.1" }), "100.64.0.1");
  assert.equal(clientHost({ LUXE_HOST: "0.0.0.0" }), LOOPBACK_HOST);
  assert.equal(clientHost({ LUXE_HOST: "::" }), IPV6_LOOPBACK_HOST);
});

test("extraAllowedHosts parses the whitespace-separated opt-in list", () => {
  assert.deepEqual(extraAllowedHosts({}), []);
  assert.deepEqual(extraAllowedHosts({ LUXE_ALLOWED_HOSTS: "" }), []);
  assert.deepEqual(extraAllowedHosts({ LUXE_ALLOWED_HOSTS: "  " }), []);
  assert.deepEqual(extraAllowedHosts({ LUXE_ALLOWED_HOSTS: "proxy.example" }), ["proxy.example"]);
  assert.deepEqual(extraAllowedHosts({ LUXE_ALLOWED_HOSTS: "  a.example   b.example\tc.example  " }), [
    "a.example",
    "b.example",
    "c.example",
  ]);
  assert.deepEqual(extraAllowedHosts({ LUXE_ALLOWED_HOSTS: "*" }), ["*"]);
});

test("linkHost prefers LUXE_LINK_HOST, then falls back to the dial host", () => {
  assert.equal(linkHost({}), LOOPBACK_HOST);
  assert.equal(linkHost({ LUXE_LINK_HOST: "host.example" }), "host.example");
  assert.equal(linkHost({ LUXE_LINK_HOST: "  " }), LOOPBACK_HOST);
  // Non-wildcard bind with no explicit link host -> links reuse the bind address.
  assert.equal(linkHost({ LUXE_HOST: "100.64.0.1" }), "100.64.0.1");
  // Wildcard bind with an explicit link host -> links use the hostname, not 0.0.0.0.
  assert.equal(linkHost({ LUXE_HOST: "0.0.0.0", LUXE_LINK_HOST: "host.example" }), "host.example");
  // IPv6 wildcard bind with no explicit link host -> links fall back to the IPv6 loopback.
  assert.equal(linkHost({ LUXE_HOST: "::" }), IPV6_LOOPBACK_HOST);
});

test("hostForUrl brackets IPv6 literals but leaves IPv4 and hostnames alone", () => {
  assert.equal(hostForUrl("127.0.0.1"), "127.0.0.1");
  assert.equal(hostForUrl("host.example"), "host.example");
  assert.equal(hostForUrl("::1"), "[::1]");
  assert.equal(hostForUrl("[::1]"), "[::1]");
});

test("remote binding requires the exact opt-in while every loopback form remains local", () => {
  for (const host of [
    "localhost",
    "LOCALHOST",
    "127.0.0.1",
    "127.255.255.255",
    "::1",
    "0:0:0:0:0:0:0:1",
    "::ffff:127.0.0.1",
    "::ffff:127.42.7.9",
    "::ffff:7f00:1",
    "0:0:0:0:0:ffff:7f2a:709",
  ]) {
    assert.equal(isLoopbackHost(host), true, host);
    assert.equal(remoteBindingAllowed(host, {}), true, host);
  }

  for (const host of [
    "0.0.0.0",
    "::",
    "192.168.1.5",
    "10.0.0.1",
    "host.example",
    "localhost.example",
    "user@127.0.0.1",
    "127.0.0.1:4387",
    "127.0.0.1/path",
    "0177.0.0.1",
  ]) {
    assert.equal(isLoopbackHost(host), false, host);
    assert.equal(remoteBindingAllowed(host, {}), false, host);
    assert.equal(remoteBindingAllowed(host, { LUXE_ALLOWED_HOSTS: "* proxy.example" }), false, host);
    assert.equal(remoteBindingAllowed(host, { LUXE_ALLOW_REMOTE: "true" }), false, host);
    assert.equal(remoteBindingAllowed(host, { LUXE_ALLOW_REMOTE: " 1 " }), false, host);
    assert.equal(remoteBindingAllowed(host, { LUXE_ALLOW_REMOTE: "1" }), true, host);
  }
});
