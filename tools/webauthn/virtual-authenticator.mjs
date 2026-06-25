/**
 * Manual S2 verification: drives a real passkey ceremony (register + login + a tampered-signature
 * negative case) against a running gateway using a Playwright CHROMIUM virtual authenticator.
 * NOT part of the node-fetch CI smoke (that runtime has no authenticator). Run locally:
 *
 *   # 1) start a gateway whose APP_URL matches this harness origin:
 *   APP_URL=http://localhost:4300 RP_ID=localhost PORT=8803 INGEST_SECRET=change-me \
 *     pnpm --filter @aprsweb/node-gateway start
 *   # 2) with playwright + chromium available:
 *   node tools/webauthn/virtual-authenticator.mjs        # expects "RESULT: PASS"
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
const HTML = readFileSync(new URL("./harness.html", import.meta.url));
const GW = process.env.GW ?? "http://localhost:8803";
const hsrv = createServer((_q, s) => { s.writeHead(200, { "content-type": "text/html" }); s.end(HTML); });
await new Promise((r) => hsrv.listen(4300, r));
const b = await chromium.launch({ args: ["--no-sandbox"] });
const ctx = await b.newContext();
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
await page.goto("http://localhost:4300/");
const reg = await page.evaluate((gw) => window.acReg(gw, "OE8APR"), GW);
const login = await page.evaluate((gw) => window.acLogin(gw, "OE8APR", false), GW);
const tamper = await page.evaluate((gw) => window.acLogin(gw, "OE8APR", true), GW);
console.log("REGISTER:", JSON.stringify(reg));
console.log("LOGIN:", JSON.stringify(login));
console.log("TAMPERED:", JSON.stringify(tamper));
const pass = reg.body?.ok && login.body?.ok && tamper.status === 400;
console.log(pass ? "RESULT: PASS" : "RESULT: FAIL");
await b.close(); hsrv.close();
process.exit(pass ? 0 : 1);
