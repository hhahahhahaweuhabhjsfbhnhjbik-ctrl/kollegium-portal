import { randomBytes, scryptSync } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPortalServer } from "../server.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dbPath = path.join(root, "data", "demo-portal.sqlite");
const portal = createPortalServer({ dbPath, cookieSecure: false });
const db = portal.portalDb;
const accounts = [
  { username: "demo-trainee", displayName: "Демо-стажёр", role: "Стажер КА" },
  { username: "demo-lawyer", displayName: "Демо-юрист", role: "Юрист" }
];

try {
  const existing = accounts.map(({ username }) =>
    db.prepare("SELECT 1 FROM users WHERE username = ?").get(username));
  if (existing.some(Boolean)) {
    throw new Error("Демо-аккаунты уже созданы. Пароли повторно не выводятся.");
  }

  const credentials = accounts.map((account) => ({
    ...account,
    password: randomBytes(18).toString("base64url")
  }));
  db.exec("BEGIN IMMEDIATE");
  try {
    const insert = db.prepare(`INSERT INTO users
      (username, password_hash, display_name, role, status) VALUES (?, ?, ?, ?, 'active')`);
    for (const account of credentials) {
      const salt = randomBytes(16);
      const hash = scryptSync(account.password, salt, 64, {
        N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024
      });
      insert.run(
        account.username,
        `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`,
        account.displayName,
        account.role
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  console.log("Созданы аккаунты в отдельной БД data/demo-portal.sqlite:");
  for (const { username, password, role } of credentials) {
    console.log(`${role}: логин ${username}, пароль ${password}`);
  }
} finally {
  portal.webhookDispatcher?.stop();
  db.close();
}
