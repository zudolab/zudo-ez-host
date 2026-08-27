import type { ControlDatabase } from "./database.js";
import { machines, projectHeads, projects, users, type User } from "./schema.js";

type UserInsert = typeof users.$inferInsert;
export type UserSeed = Omit<
  UserInsert,
  "createdAt" | "email" | "emailVerified" | "name" | "updatedAt"
> & {
  createdAt: Date | number;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  updatedAt?: Date | number;
};
export type MachineSeed = typeof machines.$inferInsert;
export type ProjectSeed = typeof projects.$inferInsert;

function seedDate(value: Date | number): Date {
  return value instanceof Date ? value : new Date(value);
}

export async function seedUser(
  database: ControlDatabase,
  seed: UserSeed & { canonicalHandle: string },
): Promise<User & { canonicalHandle: string }>;
export async function seedUser(database: ControlDatabase, seed: UserSeed): Promise<User>;
export async function seedUser(database: ControlDatabase, seed: UserSeed): Promise<User> {
  const createdAt = seedDate(seed.createdAt);
  return database
    .insert(users)
    .values({
      ...seed,
      createdAt,
      email: seed.email ?? `${seed.id}@example.invalid`,
      emailVerified: seed.emailVerified ?? false,
      name: seed.name ?? seed.canonicalHandle ?? seed.id,
      updatedAt: seedDate(seed.updatedAt ?? createdAt),
    })
    .returning()
    .get();
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
