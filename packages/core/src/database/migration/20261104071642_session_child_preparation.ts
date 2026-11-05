import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261104071642_session_child_preparation",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_child_preparation\` (
          \`admission_id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`child_session_id\` text NOT NULL,
          \`status\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_child_preparation_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`session_child_preparation_session_status_idx\` ON \`session_child_preparation\` (\`session_id\`,\`status\`);`,
      )
    })
  },
}

export default migration
