// SPDX-License-Identifier: AGPL-3.0-or-later
// The gateway serves /.well-known/security.txt from its own configuration, and answers 404 while it has no
// contact to name.
import { describe, it, expect } from "vitest";
import { authEnv, ORIGIN } from "./helpers/authflow.js";
import { serve } from "./helpers/fedpeer.js";

const get = (env: ReturnType<typeof authEnv>) =>
  serve(env)(new Request(`${ORIGIN}/.well-known/security.txt`, { headers: { "x-real-ip": "192.0.2.10" } }));

describe("/.well-known/security.txt", () => {
  it("names SECURITY_CONTACT", async () => {
    const res = await get(authEnv({ SECURITY_CONTACT: "mailto:security@example.net", OPERATOR_EMAIL: "op@x.test" }));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/^Contact: mailto:security@example\.net\nExpires: \d{4}-\d\d-\d\dT[\d:]+Z\n/);
    expect(body).toContain("Preferred-Languages: en, de\n");
  });

  it("falls back to OPERATOR_EMAIL, and is a 404 without either", async () => {
    expect(await (await get(authEnv({ OPERATOR_EMAIL: "op@example.net" }))).text()).toContain(
      "Contact: mailto:op@example.net\n",
    );
    expect((await get(authEnv())).status).toBe(404);
  });
});
