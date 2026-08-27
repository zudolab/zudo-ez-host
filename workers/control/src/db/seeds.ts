import type { ControlDatabase } from "./database.js";
import { machines, projectHeads, projects, users } from "./schema.js";

export type UserSeed = typeof users.$inferInsert;
export type MachineSeed = typeof machines.$inferInsert;
export type ProjectSeed = typeof projects.$inferInsert;

export async function seedUser(database: ControlDatabase, seed: UserSeed) {
  return database.insert(users).values(seed).returning().get();
}

export async function seedMachine(database: ControlDatabase, seed: MachineSeed) {
  return database.insert(machines).values(seed).returning().get();
}

export async function seedProject(database: ControlDatabase, seed: ProjectSeed) {
  const project = await database.insert(projects).values(seed).returning().get();
  await database.insert(projectHeads).values({
    projectId: project.id,
    updatedAt: project.createdAt,
  });
  return project;
}
