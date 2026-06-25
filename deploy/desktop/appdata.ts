import { homedir } from "node:os";
import { join } from "node:path";

/** Per-OS application data directory (where the SQLite DB + config live). */
export function appDataDir(app: string): string {
  if (process.platform === "win32")
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), app);
  if (process.platform === "darwin")
    return join(homedir(), "Library", "Application Support", app);
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), app);
}
