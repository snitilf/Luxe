import { chmod, mkdir, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const LOOPBACK_HOST = "127.0.0.1";
export const IPV6_LOOPBACK_HOST = "::1";

// Binding to a wildcard address means "all interfaces" - it is not itself a connectable
// target, so the CLI's local control channel falls back to the matching-family loopback.
// :: must fold to ::1 (not 127.0.0.1) because on macOS/BSD IPV6_V6ONLY defaults on, so a
// ::-bound socket rejects IPv4 loopback connections.
const WILDCARD_BIND_LOOPBACK = new Map([
  ["0.0.0.0", LOOPBACK_HOST],
  ["::", IPV6_LOOPBACK_HOST],
]);

// Address the server binds to (LUXE_HOST). Defaults to loopback. A wildcard value
// (0.0.0.0 or ::) binds every interface.
export function bindHost(env = process.env) {
  return env.LUXE_HOST?.trim() || LOOPBACK_HOST;
}

// Host the CLI uses to reach the server it spawned. A wildcard bind address can't be
// dialed directly, so the local control channel falls back to loopback.
export function clientHost(env = process.env) {
  const host = bindHost(env);
  return WILDCARD_BIND_LOOPBACK.get(host) ?? host;
}

// Hostname written into the session URLs the server generates (LUXE_LINK_HOST).
// Defaults to the host the CLI dials.
export function linkHost(env = process.env) {
  return env.LUXE_LINK_HOST?.trim() || clientHost(env);
}

// Extra Host header values the server's DNS-rebinding guard accepts beyond the
// loopback names and the resolved bind/link host, set via LUXE_ALLOWED_HOSTS
// (whitespace-separated). A lone "*" disables the guard entirely - an explicit
// opt-out for operators fronting the server with their own auth/proxy.
export function extraAllowedHosts(env = process.env) {
  return (env.LUXE_ALLOWED_HOSTS || "").split(/\s+/).filter(Boolean);
}

// Brackets an IPv6 literal so it can be safely interpolated into a URL authority.
// IPv4 addresses and hostnames pass through unchanged.
export function hostForUrl(host) {
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}

export function stateDir() {
  return process.env.LUXE_STATE_DIR || path.join(os.homedir(), ".luxe");
}

export function stateFile() {
  return path.join(stateDir(), "state.json");
}

export function serverLogFile() {
  return path.join(stateDir(), "server.log");
}

// The state directory holds every session's queued prompts, chat history, whiteboard scenes
// and DOM snapshots - a text outline of whatever each artifact rendered, which can include
// anything the artifact put on screen - plus server.log, which records the artifact file
// paths the server has served. It is one shared directory across every project on the
// machine, so it is owner-only: 0700 on the directories, 0600 on state.json and server.log.
// Those modes are applied on creation and re-applied here at every CLI start, so anything an
// older version created (or a stray chmod loosened) is tightened the next time Luxe runs.
// chmod is a no-op that can also throw on win32, where POSIX mode bits are not the ACL that
// matters; the guard keeps Windows on its own filesystem defaults rather than pretending.
export const STATE_DIR_MODE = 0o700;
export const STATE_FILE_MODE = 0o600;

export function supportsPosixFileModes() {
  return process.platform !== "win32";
}

export async function ensureStateDir() {
  const dir = stateDir();
  await mkdir(dir, { recursive: true, mode: STATE_DIR_MODE });
  if (!supportsPosixFileModes()) return;
  await tightenExisting(dir, STATE_DIR_MODE);
  await tightenExisting(stateFile(), STATE_FILE_MODE);
  // server.log is opened 0600 by startServer(), but only when it does not already exist -
  // an append open leaves an older, looser log exactly as it found it. It is the same class
  // of leak as state.json, so it gets the same startup pass.
  await tightenExisting(serverLogFile(), STATE_FILE_MODE);
  await tightenWhiteboardDirs();
}

// The whiteboard sidecar tree is exactly two levels deep (<state>/whiteboards/<session key>)
// and both levels are created 0700 by whiteboard-store.js, so re-tightening it is one
// readdir. Directories only: the scene files inside them are written with the process
// default and are protected by these 0700 parents, which is what docs/security.md states.
async function tightenWhiteboardDirs() {
  const root = path.join(stateDir(), "whiteboards");
  await tightenExisting(root, STATE_DIR_MODE);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return; // No whiteboards yet, or not ours to read.
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await tightenExisting(path.join(root, entry.name), STATE_DIR_MODE);
  }
}

// Best-effort: a state directory owned by another user, or a read-only volume, must not stop
// the CLI from running. The failure mode we care about is a world-readable state file, and
// that is fixed on the next write when chmod is refused here.
async function tightenExisting(target, mode) {
  try {
    const stats = await stat(target);
    if ((stats.mode & 0o777) === mode) return;
    await chmod(target, mode);
  } catch {
    // Missing (state.json before the first write) or not ours to change - leave it alone.
  }
}

export function defaultPort() {
  return Number(process.env.LUXE_PORT || 4387);
}
