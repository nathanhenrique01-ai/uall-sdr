import fs from "fs";
import path from "path";
import {
  hasRemoteAuthSession,
  getRemoteAuthSession,
  saveRemoteAuthSession,
  deleteRemoteAuthSession,
  getAccountInfo,
} from "./db.js";

function normalizeSessionName(session) {
  if (!session) return "RemoteAuth";
  return path.basename(String(session)).replace(/\.zip$/i, "");
}

export class MariaDbAuthStore {
  async sessionExists(options) {
    return await hasRemoteAuthSession(normalizeSessionName(options && options.session));
  }

  async save(options) {
    var sessionPath = options && options.session ? String(options.session) : "";
    var sessionName = normalizeSessionName(sessionPath);
    var zipPath = sessionPath.endsWith(".zip") ? sessionPath : sessionPath + ".zip";
    var buffer = await fs.promises.readFile(zipPath);
    var accountInfo = await getAccountInfo();
    await saveRemoteAuthSession(sessionName, buffer, accountInfo && accountInfo.phone ? accountInfo.phone : null);
  }

  async extract(options) {
    var sessionName = normalizeSessionName(options && options.session);
    var targetPath = options && options.path ? String(options.path) : "";
    var session = await getRemoteAuthSession(sessionName);
    if (!session || !session.sessionZip) return;
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.promises.writeFile(targetPath, session.sessionZip);
  }

  async delete(options) {
    await deleteRemoteAuthSession(normalizeSessionName(options && options.session));
  }
}
