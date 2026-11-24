// Escape checks for `brine-sandbox --check`. The launcher runs this file three ways:
//
//   node checks.mjs serve <dir>          live fixtures outside the sandbox: Unix, abstract, TCP
//                                        and UDP receivers that log every connection to <dir>/hits
//   node checks.mjs probe <mode> <json>  the probes. mode is one of
//     control  outside the sandbox, where every access is allowed. Each probe must see "reached",
//              which shows it can tell access from denial on this machine.
//     sandbox  inside the sandbox Pi gets. Each probe must see a denial it can attribute.
//     widened  inside a sandbox with the fixture secret and socket deliberately granted. Those
//              probes must see "reached", so a grant that slips in can't pass unnoticed.
//
// A probe only passes on evidence specific to its denial: an errno from the kernel, or a
// response that identifies nono as the one refusing. Anything else (a missing file, a missing
// tool, a timeout) is inconclusive and blocks the all-clear. Probes never print what they read;
// file and variable contents are compared against the canary's hash only.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import dgram from "node:dgram";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const DENIED = new Set(["EACCES", "EPERM"]);
const result = (state, evidence) => ({ state, evidence });
const fromError = (e) => (DENIED.has(e.code) ? result("denied", e.code) : result("unknown", e.code ?? e.message));

// ---------------------------------------------------------------------------------------------
// Fixtures

function serve(dir) {
  const hits = fs.openSync(path.join(dir, "hits"), "a");
  const hit = (kind, data) => fs.writeSync(hits, `${kind} ${String(data).trim().slice(0, 40)}\n`);
  const echo = (kind) => (sock) => sock.once("data", (d) => (hit(kind, d), sock.end("ack\n")));
  const sockPath = path.join(dir, "sock");
  const abstract = `\0brine-sandbox-check-${path.basename(dir)}`;
  const tcp = net.createServer(echo("tcp")).listen(0, "127.0.0.1");
  net.createServer(echo("unix")).listen(sockPath);
  net.createServer(echo("abstract")).listen(abstract);
  const udp = dgram.createSocket("udp4");
  udp.on("message", (d, rinfo) => (hit("udp", d), udp.send("ack\n", rinfo.port, rinfo.address)));
  udp.bind(0, "127.0.0.1", () => {
    const info = { pid: process.pid, sock: sockPath, abstract, tcp: tcp.address().port, udp: udp.address().port };
    fs.writeFileSync(path.join(dir, "receivers.json"), JSON.stringify(info));
  });
}

// ---------------------------------------------------------------------------------------------
// Primitives. Each returns { state: "reached" | "denied" | "unknown", evidence }.

function readFile(file, canaryHash) {
  try {
    const data = fs.readFileSync(file);
    const match = canaryHash && sha256(data.toString().trim()) === canaryHash ? ", contents match the canary" : "";
    return result("reached", `read ${data.length} bytes${match}`);
  } catch (e) {
    return fromError(e);
  }
}

function listDir(dir) {
  try {
    return result("reached", `listed ${fs.readdirSync(dir).length} entries`);
  } catch (e) {
    return fromError(e);
  }
}

function appendFile(file) {
  // Opens for append and writes nothing, so a successful control run changes no content.
  try {
    fs.closeSync(fs.openSync(file, "a"));
    return result("reached", "opened for writing");
  } catch (e) {
    return fromError(e);
  }
}

function createFile(dir) {
  const file = path.join(dir, `.brine-sandbox-check-${process.pid}`);
  try {
    fs.closeSync(fs.openSync(file, "wx"));
    fs.unlinkSync(file);
    return result("reached", "created and removed a file");
  } catch (e) {
    return fromError(e);
  }
}

// Connects, sends a tag, and waits for the receiver's ack. Without an ack the connection
// can't be attributed to the receiver, so it counts as unknown.
function connect(opts, tag, expectAck) {
  return new Promise((resolve) => {
    const sock = net.connect(opts);
    const done = (r) => (sock.destroy(), clearTimeout(timer), resolve(r));
    const timer = setTimeout(() => done(result("unknown", "no answer in 3s")), 3000);
    sock.on("error", (e) => done(fromError(e)));
    sock.on("connect", () => {
      if (!expectAck) return done(result("reached", "connected"));
      sock.write(`${tag}\n`);
      sock.once("data", () => done(result("reached", "connected, receiver answered")));
    });
  });
}

function udp(port, tag) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    const done = (r) => (clearTimeout(timer), sock.close(), resolve(r));
    const timer = setTimeout(() => done(result("unknown", "sent, but no answer in 3s; delivery unknown")), 3000);
    sock.on("error", (e) => done(fromError(e)));
    sock.on("message", () => done(result("reached", "receiver answered")));
    sock.send(`${tag}\n`, port, "127.0.0.1", (e) => e && done(fromError(e)));
  });
}

function signal(pid) {
  try {
    process.kill(pid, 0);
    return result("reached", "signal 0 delivered");
  } catch (e) {
    return fromError(e);
  }
}

// Runs curl and returns what the checks need without ever printing the response. Everything
// stays in memory: inside the sandbox /tmp is write-only.
function curl(args) {
  const r = spawnSync("curl", ["-sS", "-v", "-i", "-m", "10", "-w", "\n%{http_code} %{http_connect}", ...args], {
    encoding: "utf8",
    maxBuffer: 1 << 20,
  });
  const stdout = r.stdout ?? "";
  const cut = stdout.lastIndexOf("\n");
  const [code, connectCode] = stdout.slice(cut + 1).split(" ").map(Number);
  // -i includes the proxy's "200 Connection Established" as well. Use the last response.
  const response = stdout.slice(0, cut);
  const start = [...response.matchAll(/^HTTP\/[\d.]+ \d+/gm)].pop()?.index ?? 0;
  const rest = response.slice(start);
  const split = rest.search(/\r?\n\r?\n/);
  const headers = split < 0 ? rest : rest.slice(0, split);
  const body = split < 0 ? "" : rest.slice(split).replace(/^\r?\n\r?\n/, "");
  return {
    error: r.error?.code,
    exit: r.status,
    code,
    connectCode,
    verbose: r.stderr ?? "",
    body,
    server: /^server:\s*(.+)$/im.exec(headers)?.[1]?.trim(),
    issuer: /issuer:\s*(.+)$/m.exec(r.stderr ?? "")?.[1]?.trim(),
  };
}

const curlMissing = (r) => r.error === "ENOENT" && result("unknown", "curl not found");

// nono's own refusals carry no Server header and a fixed JSON body.
const nonoRefused = (r, status, body) => r.code === status && !r.server && r.body.trim() === body;
const proxyRefused = (r) => r.exit === 56 && r.connectCode === 403 && /is not in the allowlist/.test(r.verbose);

function viaProxy(url, extra = []) {
  const r = curl([...extra, url]);
  if (curlMissing(r)) return curlMissing(r);
  if (proxyRefused(r)) return result("denied", "nono proxy refused CONNECT (403, not in the allowlist)");
  if (r.code > 0) return result("reached", `HTTP ${r.code}${r.server ? ` from ${r.server}` : ""}`);
  return result("unknown", `curl exit ${r.exit}, CONNECT ${r.connectCode || "none"}`);
}

// ---------------------------------------------------------------------------------------------
// Probes. `sandbox: true` probes are positive checks that only make sense inside the sandbox;
// they return pass/fail directly. The others return reached/denied/unknown in every mode.

function probes(p) {
  const B = process.env.BRINE_BASE_URL;
  const token = ["-H", `Authorization: Bearer ${process.env.BRINE_API_KEY}`];
  const route = (desc, method, pathPart) => ({
    desc,
    sandbox: true,
    run: () => {
      const r = curl(["--path-as-is", "-X", method, ...token, ...(method === "POST" ? ["-d", "{}"] : []), B + pathPart]);
      if (curlMissing(r)) return curlMissing(r);
      if (nonoRefused(r, 403, '{"error":"Forbidden"}')) return result("pass", "nono refused it (403)");
      return result("fail", `HTTP ${r.code}${r.server ? ` from ${r.server}` : " (no Server header)"}`);
    },
  });
  // Presence comes from the launcher, outside: inside the sandbox a missing file and a
  // hidden one can look alike.
  const ifPresent = (present, what, run) => (present ? run : () => result("skip", `${what} not present on this host`));
  const hostSockets = p.hostSockets.map(([name, file, present]) => ({
    desc: `connect to ${name}`,
    run: ifPresent(present, "socket", () => connect({ path: file }, "", false)),
  }));

  return [
    // Network
    { desc: "internet through the proxy (example.com)", run: () => viaProxy("https://example.com/") },
    { desc: "Plausible vhost by IP through the proxy", run: () => viaProxy("https://199.241.160.16/api/health", ["-k", "-H", "Host: x"]) },
    {
      desc: "fronting: Brine's hostname, Host: x",
      run: () => {
        // Outside the sandbox this reaches the Plausible vhost that shares Brine's IP. Inside,
        // nono must terminate the TLS itself and the answer must come from Brine, not Plausible.
        const r = curl(["-H", "Host: x", "https://brine.sharcnet.ca/api/health"]);
        if (curlMissing(r)) return curlMissing(r);
        if (r.code === 200 && /"clickhouse"/.test(r.body)) return result("reached", "Plausible answered (200, its health JSON)");
        if (/nono-session-ca/.test(r.issuer ?? "") && r.code === 404 && r.body.trim() === '{"detail":"Not Found"}')
          return result("denied", "TLS terminated by nono; Brine answered 404");
        return result("unknown", `HTTP ${r.code}, issuer ${r.issuer ?? "none"}`);
      },
    },
    { desc: "direct TCP to Brine's IP, no proxy", run: () => connect({ host: "199.241.160.16", port: 443 }, "", false) },
    { desc: "TCP to a localhost service (fixture)", run: () => connect({ host: "127.0.0.1", port: p.fixtures.tcp }, p.mode, true) },
    { desc: "UDP to a localhost receiver (fixture)", run: () => udp(p.fixtures.udp, p.mode) },
    {
      desc: "Brine route: GET /models works",
      sandbox: true,
      run: () => {
        const r = curl([...token, B + "/models"]);
        if (curlMissing(r)) return curlMissing(r);
        let n = 0;
        try {
          n = JSON.parse(r.body).data.length;
        } catch {}
        return r.code === 200 && n > 0 ? result("pass", `200, ${n} models`) : result("fail", `HTTP ${r.code}`);
      },
    },
    route("Brine route: POST /key/generate", "POST", "/key/generate"),
    route("Brine route: ../ traversal", "GET", "/models/../../key/info"),
    route("Brine route: %2e%2e traversal", "GET", "/models/%2e%2e/%2e%2e/key/info"),
    route("Brine route: %2f-encoded slashes", "GET", "/models%2f..%2f..%2fkey%2finfo"),
    route("Brine route: double-encoded %252e", "GET", "/models/%252e%252e/%252e%252e/key/info"),
    route("Brine route: ..; segment", "GET", "/models/..;/..;/key/info"),
    route("Brine route: // prefix", "GET", "//key/info"),
    route("Brine route: case variant /MODELS", "GET", "/MODELS"),
    route("Brine route: POST /chat/completions/../..", "POST", "/chat/completions/../../key/generate"),
    {
      desc: "Brine route without the session token",
      sandbox: true,
      run: () => {
        const r = curl([B + "/models"]);
        if (curlMissing(r)) return curlMissing(r);
        return nonoRefused(r, 401, '{"error":"Unauthorized"}')
          ? result("pass", "nono refused it (401)")
          : result("fail", `HTTP ${r.code}${r.server ? ` from ${r.server}` : ""}`);
      },
    },
    {
      desc: "CONNECT to Brine's host carries no key",
      sandbox: true,
      run: () => {
        // nono lets the agent tunnel to Brine's hostname but only injects the key on the route.
        // Brine itself must answer 401 to the session token.
        const r = curl([...token, "https://brine.sharcnet.ca/v1/models"]);
        if (curlMissing(r)) return curlMissing(r);
        return r.code === 401 && r.server === "nginx"
          ? result("pass", "Brine answered 401 to the session token")
          : result("fail", `HTTP ${r.code}${r.server ? ` from ${r.server}` : ""}`);
      },
    },

    // Unix sockets and signals
    { desc: "connect to a Unix socket (fixture)", tag: "widen", run: () => connect({ path: p.fixtures.sock }, p.mode, true) },
    { desc: "connect to an abstract socket (fixture)", run: () => connect({ path: p.fixtures.abstract }, p.mode, true) },
    ...hostSockets,
    { desc: "signal a process outside (fixture)", run: () => signal(p.fixtures.pid) },

    // Files
    { desc: "read the real Brine key", run: () => readFile(p.keyfile) },
    { desc: "read a dummy credential (fixture)", tag: "widen", run: () => readFile(p.secret, p.canaryHash) },
    { desc: "read another file in /tmp (fixture)", run: () => readFile(p.tmpSecret, p.canaryHash) },
    { desc: "list /tmp", run: () => listDir("/tmp") },
    { desc: "read ~/.pi/agent/auth.json", run: ifPresent(p.present.piAuth, "file", () => readFile(p.piAuth)) },
    { desc: "list ~/.ssh", run: ifPresent(p.present.ssh, "directory", () => listDir(p.ssh)) },
    { desc: "list home directory", run: () => listDir(p.home) },
    { desc: "write to home directory", run: () => createFile(p.home) },
    { desc: "rewrite the sandbox policy", run: () => appendFile(p.policy) },
    { desc: "rewrite the launcher", run: () => appendFile(p.launcher) },
    { desc: "list all projects' Pi state", run: () => listDir(path.dirname(path.dirname(p.otherExtensions))) },
    { desc: "list another project's Pi sessions (fixture)", run: () => listDir(path.dirname(p.otherSession)) },
    { desc: "read another project's Pi session (fixture)", run: () => readFile(p.otherSession, p.canaryHash) },
    { desc: "write another project's Pi extensions (fixture)", run: () => createFile(p.otherExtensions) },
    {
      desc: "read the nono supervisor's environment",
      run: () => {
        // Inside, our parent is the nono supervisor. If it isn't, the check can't say anything.
        const comm = (() => {
          try {
            return fs.readFileSync(`/proc/${process.ppid}/comm`, "utf8").trim();
          } catch (e) {
            return e.code;
          }
        })();
        if (p.mode !== "control" && comm !== "nono") return result("unknown", `parent is "${comm}", not nono`);
        return readFile(`/proc/${process.ppid}/environ`);
      },
    },
    {
      desc: "dummy host credentials in the environment",
      run: () => {
        // The launcher sets several dummy credentials to the canary before starting nono.
        const leaked = Object.entries(process.env).filter(([, v]) => sha256(v) === p.canaryHash).length;
        return leaked ? result("reached", `${leaked} variable(s) hold the canary`) : result("denied", "no variable holds the canary");
      },
    },
  ];
}

async function probe(mode, params) {
  const p = { ...params, mode };
  let list = probes(p);
  if (mode === "control") list = list.filter((t) => !t.sandbox);
  if (mode === "widened") list = list.filter((t) => t.tag === "widen");

  let bad = 0;
  for (const t of list) {
    const r = await t.run();
    let verdict;
    if (r.state === "skip") verdict = "SKIP";
    else if (r.state === "pass" || r.state === "fail") verdict = r.state.toUpperCase();
    else if (r.state === "unknown") verdict = "????";
    else verdict = r.state === (mode === "sandbox" ? "denied" : "reached") ? "PASS" : "FAIL";
    if (verdict === "FAIL" || verdict === "????") bad++;
    console.log(`${verdict.padEnd(4)} ${t.desc.padEnd(48)} ${r.evidence}`);
  }
  return bad;
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "serve") serve(rest[0]);
else if (cmd === "probe") process.exit((await probe(rest[0], JSON.parse(rest[1]))) ? 1 : 0);
else {
  console.error("usage: checks.mjs serve <dir> | probe <control|sandbox|widened> <json>");
  process.exit(2);
}
