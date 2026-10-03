import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
export function recoveryDB() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("./migrations/0001_scorers.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("./migrations/0002_match_recovery.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("./migrations/0003_players.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("./migrations/0004_match_audit.sql", import.meta.url), "utf8"));
  sqlite.exec("INSERT INTO scorers VALUES('first@example.com','First',1,1), ('second@example.com','Second',1,1)");
  return { sqlite, DB: { prepare(sql) {
    const statement = sqlite.prepare(sql);
    return { bind(...args) { return {
      first: async () => statement.get(...args) || null,
      all: async () => ({ results: statement.all(...args) }),
      run: async () => statement.run(...args),
    }; } };
  } } };
}
