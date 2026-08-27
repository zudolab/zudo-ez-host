import { drizzle } from "drizzle-orm/d1";

import { schema } from "./schema.js";

export function createControlDatabase(binding: D1Database) {
  return drizzle(binding, { schema });
}

export type ControlDatabase = ReturnType<typeof createControlDatabase>;
