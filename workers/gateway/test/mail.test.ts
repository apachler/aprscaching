// SPDX-License-Identifier: AGPL-3.0-or-later
// Outgoing mail: the transport rule (SMTP when SMTP_HOST is set, else Resend with EMAIL_API_KEY, else none),
// a real SMTP exchange against a local fake server (login, headers, body), and the failures a send must
// survive without throwing: a refused login, a server that never greets, a server that cannot STARTTLS.
import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { mailTransport, sendEmail, deliverMail, handleMailTest } from "../src/mail.js";
import type { Env } from "../src/env.js";

type Received = { auth: string[]; from: string; to: string[]; data: string };
type FakeOpts = { refuseLogin?: boolean; silent?: boolean };

/** A local SMTP server speaking just enough of the protocol: EHLO, AUTH PLAIN, MAIL, RCPT, DATA, QUIT. */
async function fakeSmtp(opts: FakeOpts = {}): Promise<{ port: number; got: Received[]; close: () => Promise<void> }> {
  const got: Received[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => {});
    if (opts.silent) return; // accepts the connection, never greets
    const msg: Received = { auth: [], from: "", to: [], data: "" };
    let buf = "";
    let inData = false;
    let authNext = false;
    const say = (line: string) => sock.write(line + "\r\n");
    say("220 fake.test ESMTP");
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end < 0) return;
          msg.data = buf.slice(0, end);
          buf = buf.slice(end + 5);
          inData = false;
          got.push(msg);
          say("250 queued");
          continue;
        }
        const nl = buf.indexOf("\r\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const cmd = line.toUpperCase();
        if (authNext) {
          authNext = false;
          msg.auth.push(line);
          say(opts.refuseLogin ? "535 5.7.8 authentication failed" : "235 ok");
        } else if (cmd.startsWith("EHLO") || cmd.startsWith("HELO")) {
          say("250-fake.test");
          say("250-AUTH PLAIN");
          say("250 8BITMIME");
        } else if (cmd.startsWith("AUTH PLAIN")) {
          const inline = line.slice("AUTH PLAIN".length).trim();
          if (inline) {
            msg.auth.push(inline);
            say(opts.refuseLogin ? "535 5.7.8 authentication failed" : "235 ok");
          } else {
            authNext = true;
            say("334 ");
          }
        } else if (cmd.startsWith("MAIL FROM:")) {
          msg.from = line.slice(10).trim();
          say("250 ok");
        } else if (cmd.startsWith("RCPT TO:")) {
          msg.to.push(line.slice(8).trim());
          say("250 ok");
        } else if (cmd === "DATA") {
          inData = true;
          say("354 go ahead");
        } else if (cmd === "QUIT") {
          say("221 bye");
          sock.end();
        } else if (cmd === "RSET" || cmd === "NOOP") {
          say("250 ok");
        } else {
          say("502 not implemented");
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    got,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

const smtpEnv = (port: number, extra: Partial<Env> = {}): Env =>
  ({
    EMAIL_FROM: "aprscaching <noreply@aprs.example.net>",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(port),
    SMTP_SECURE: "none",
    SMTP_USER: "noreply@aprs.example.net",
    SMTP_PASS: "mailbox-password",
    ...extra,
  }) as Env;

let closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.map((c) => c()));
  closers = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function server(opts?: FakeOpts) {
  const s = await fakeSmtp(opts);
  closers.push(s.close);
  return s;
}

describe("mailTransport — which way mail leaves", () => {
  it("SMTP when SMTP_HOST is set, even with a Resend key beside it", () => {
    const t = mailTransport({ EMAIL_FROM: "a@b.example", SMTP_HOST: "mail.b.example", EMAIL_API_KEY: "re_x" } as Env);
    expect(t).toEqual({ kind: "smtp", host: "mail.b.example", port: 587, security: "starttls" });
  });
  it("Resend when only EMAIL_API_KEY is set", () => {
    expect(mailTransport({ EMAIL_FROM: "a@b.example", EMAIL_API_KEY: "re_x" } as Env)).toEqual({
      kind: "resend",
      host: "api.resend.com",
    });
  });
  it("none without either, and none without a sender", () => {
    expect(mailTransport({ EMAIL_FROM: "a@b.example" } as Env)).toBeNull();
    expect(mailTransport({ SMTP_HOST: "mail.b.example", EMAIL_API_KEY: "re_x" } as Env)).toBeNull();
  });
  it("port 465 is TLS from the first byte; SMTP_SECURE overrides the port's default", () => {
    const at = (env: Partial<Env>) => mailTransport({ EMAIL_FROM: "a@b.example", SMTP_HOST: "h", ...env } as Env);
    expect(at({ SMTP_PORT: "465" })).toMatchObject({ port: 465, security: "tls" });
    expect(at({ SMTP_PORT: "25", SMTP_SECURE: "none" })).toMatchObject({ port: 25, security: "none" });
    expect(at({ SMTP_PORT: "2465", SMTP_SECURE: "tls" })).toMatchObject({ security: "tls" });
  });
});

describe("sendEmail over SMTP", () => {
  it("logs in, and delivers a plain-text mail with Date and a Message-ID on the sender's domain", async () => {
    const s = await server();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const ok = await sendEmail(
      smtpEnv(s.port, { EMAIL_API_KEY: "re_x" }),
      "ham@example.org",
      "Sign in",
      "Hello\nline two",
    );
    expect(ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled(); // SMTP set: Resend is not asked
    expect(s.got).toHaveLength(1);
    const m = s.got[0]!;
    expect(Buffer.from(m.auth[0]!, "base64").toString("utf8")).toBe("\0noreply@aprs.example.net\0mailbox-password");
    expect(m.from).toContain("noreply@aprs.example.net");
    expect(m.to).toEqual(["<ham@example.org>"]);
    expect(m.data).toMatch(/^Date: /m);
    expect(m.data).toMatch(/^Message-ID: <[0-9a-f-]{36}@aprs\.example\.net>$/m);
    expect(m.data).toMatch(/^Subject: Sign in$/m);
    expect(m.data).toMatch(/^Content-Type: text\/plain/m);
    expect(m.data).toContain("Hello\r\nline two");
  });

  it("sends without a login when SMTP_USER is unset", async () => {
    const s = await server();
    expect(await sendEmail(smtpEnv(s.port, { SMTP_USER: undefined }), "ham@example.org", "s", "t")).toBe(true);
    expect(s.got[0]!.auth).toEqual([]);
  });

  it("a refused login is false, never a throw, and the warning carries no password and no address", async () => {
    const s = await server({ refuseLogin: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await deliverMail(smtpEnv(s.port), "ham@example.org", "s", "secret body");
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toContain("535");
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    expect(line).toContain("SMTP 127.0.0.1");
    for (const leak of ["mailbox-password", "ham@example.org", "secret body"]) expect(line).not.toContain(leak);
  });

  it("gives up on a server that never greets within the timeout", async () => {
    const s = await server({ silent: true });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const t0 = Date.now();
    const res = await deliverMail(smtpEnv(s.port), "ham@example.org", "s", "t", 300);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toMatch(/ETIMEDOUT|greeting/i);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("STARTTLS is required: a server that cannot upgrade gets nothing in the clear", async () => {
    const s = await server();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await sendEmail(smtpEnv(s.port, { SMTP_SECURE: undefined }), "ham@example.org", "s", "t")).toBe(false);
    expect(s.got).toHaveLength(0);
    expect(s.got.flatMap((m) => m.auth)).toEqual([]);
  });

  it("a closed port is false, not a throw", async () => {
    const s = await server();
    const port = s.port;
    await s.close();
    closers = [];
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await sendEmail(smtpEnv(port), "ham@example.org", "s", "t")).toBe(false);
  });
});

describe("sendEmail over Resend, and with no transport", () => {
  it("posts to the Resend API when only EMAIL_API_KEY is set", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const env = { EMAIL_FROM: "noreply@aprs.example.net", EMAIL_API_KEY: "re_key" } as Env;
    expect(await sendEmail(env, "ham@example.org", "s", "t")).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer re_key");
    expect(JSON.parse(String(init.body))).toMatchObject({ from: "noreply@aprs.example.net", to: "ham@example.org" });
  });
  it("a refusal from Resend is false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status: 403 })),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await deliverMail({ EMAIL_FROM: "a@b.example", EMAIL_API_KEY: "k" } as Env, "c@d.example", "s", "t");
    expect(res).toEqual({ ok: false, error: "HTTP 403" });
  });
  it("sends nothing and asks nobody without a transport", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await sendEmail({ EMAIL_FROM: "a@b.example" } as Env, "c@d.example", "s", "t")).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/mail-test", () => {
  const SECRET = "operator-secret-0123456789abcdef";
  const post = (env: Env, body: unknown, secret = SECRET) =>
    handleMailTest(
      new Request("http://gw/api/admin/mail-test", {
        method: "POST",
        headers: { "content-type": "application/json", "x-operator-secret": secret },
        body: JSON.stringify(body),
      }),
      env,
    );

  it("sends a test mail with the operator secret and names the transport", async () => {
    const s = await server();
    const res = await post(smtpEnv(s.port, { OPERATOR_SECRET: SECRET, APP_URL: "https://aprs.example.net" }), {
      to: "op@example.org",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, transport: `SMTP 127.0.0.1:${s.port} (none)` });
    expect(s.got[0]!.data).toMatch(/^Subject: aprscaching test mail$/m);
  });
  it("reports the server's reason when it refuses", async () => {
    const s = await server({ refuseLogin: true });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await post(smtpEnv(s.port, { OPERATOR_SECRET: SECRET }), { to: "op@example.org" });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("535");
    expect(JSON.stringify(body)).not.toContain("mailbox-password");
  });
  it("refuses a wrong operator secret and a malformed address", async () => {
    const env = smtpEnv(1, { OPERATOR_SECRET: SECRET });
    expect((await post(env, { to: "op@example.org" }, "wrong-secret-0123456789abcdef")).status).toBe(401);
    expect((await post(env, { to: "not an address" })).status).toBe(400);
  });
});
