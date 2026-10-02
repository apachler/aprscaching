// SPDX-License-Identifier: AGPL-3.0-or-later
// A station belongs to a callsign its account holds and has verified (OE8APR-9 needs OE8APR), so nobody lists
// another operator's station; the sysop lists a club station for the member who runs it.
import { describe, it, expect } from "vitest";
import { authEnv, call, emailSignup, operatorVerify } from "./helpers/authflow.js";

const station = (callsign: string) => ({ callsign, lat: 47, lon: 15 });

describe("My stations lists only stations of the account's own verified callsigns", () => {
  it("takes an SSID of a held, verified call, and refuses a call the account does not hold", async () => {
    const env = authEnv({ ADMIN_CALLSIGNS: "OE8OWN" });
    const me = await emailSignup(env, "own@example.test", "OE8OWN");
    await operatorVerify(env, "OE8OWN");
    expect((await call(env, "POST", "/api/my/stations", station("OE8OWN-9"), { cookie: me.cookie })).status).toBe(201);
    const foreign = await call(env, "POST", "/api/my/stations", station("DL1XYZ-9"), { cookie: me.cookie });
    expect(foreign.status).toBe(403);
    expect(foreign.data.error).toMatch(/not a callsign on your account/);
  });

  it("refuses a held call that is not verified yet", async () => {
    const env = authEnv();
    const me = await emailSignup(env, "new@example.test", "OE8NEW");
    const r = await call(env, "POST", "/api/my/stations", station("OE8NEW-9"), { cookie: me.cookie });
    expect(r.status).toBe(403);
    expect(r.data.error).toMatch(/verify OE8NEW first/);
  });

  it("the sysop lists a club station for a member, who then manages it", async () => {
    const env = authEnv({ ADMIN_CALLSIGNS: "OE8SYS" });
    const sysop = await emailSignup(env, "sysop@example.test", "OE8SYS");
    await operatorVerify(env, "OE8SYS");
    const member = await emailSignup(env, "member@example.test", "OE8MEM");
    const add = await call(
      env,
      "POST",
      "/api/admin/stations",
      { owner: "OE8MEM", callsign: "OE8XKR-10", lat: 47, lon: 15 },
      { cookie: sysop.cookie },
    );
    expect(add.status, JSON.stringify(add.data)).toBe(201);
    const mine = await call(env, "GET", "/api/my/stations", undefined, { cookie: member.cookie });
    const st = mine.data.stations.find((s: { callsign: string }) => s.callsign === "OE8XKR-10");
    expect(st).toBeTruthy();
    const edit = await call(
      env,
      "PATCH",
      `/api/my/stations/${st.id}`,
      { description: "club digi" },
      { cookie: member.cookie },
    );
    expect(edit.status).toBe(200);
  });

  it("only the sysop lists a station for someone else", async () => {
    const env = authEnv();
    const member = await emailSignup(env, "member@example.test", "OE8MEM");
    const r = await call(
      env,
      "POST",
      "/api/admin/stations",
      { owner: "OE8MEM", callsign: "OE8XKR-10", lat: 47, lon: 15 },
      { cookie: member.cookie },
    );
    expect(r.status).toBe(403);
  });
});
