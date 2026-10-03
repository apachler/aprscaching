// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";

/** The release version, as the APRS-IS login names its software (`vers aprscaching <version>`). */
export const SOFTWARE_VERSION = ((): string => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
      version?: string;
    };
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
