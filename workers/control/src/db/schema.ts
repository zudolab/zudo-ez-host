import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const nonNegative = (column: { name: string }) => sql`${column} >= 0`;

export const users = sqliteTable(
  "user",
  {
    id: text("id").primaryKey(),
    canonicalHandle: text("canonical_handle").notNull(),
    activeLogicalBytes: integer("active_logical_bytes").notNull().default(0),
    reservedActiveDeltaBytes: integer("reserved_active_delta_bytes").notNull().default(0),
    retainedStagedPhysicalBytes: integer("retained_staged_physical_bytes").notNull().default(0),
    reservedPhysicalUploadBytes: integer("reserved_physical_upload_bytes").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("user_canonical_handle_unique").on(table.canonicalHandle),
    check("user_canonical_handle_length", sql`length(${table.canonicalHandle}) between 3 and 20`),
    check("user_active_logical_bytes_non_negative", nonNegative(table.activeLogicalBytes)),
    check(
      "user_reserved_active_delta_bytes_non_negative",
      nonNegative(table.reservedActiveDeltaBytes),
    ),
    check(
      "user_retained_staged_physical_bytes_non_negative",
      nonNegative(table.retainedStagedPhysicalBytes),
    ),
    check(
      "user_reserved_physical_upload_bytes_non_negative",
      nonNegative(table.reservedPhysicalUploadBytes),
    ),
  ],
);

export const machines = sqliteTable(
  "machines",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    credentialHashSha256: text("credential_hash_sha256").notNull(),
    credentialPrefix: text("credential_prefix").notNull(),
    credentialVersion: integer("credential_version").notNull(),
    revoked: integer("revoked", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    uniqueIndex("machines_credential_hash_sha256_unique").on(table.credentialHashSha256),
    uniqueIndex("machines_id_user_id_unique").on(table.id, table.userId),
    index("machines_user_id_idx").on(table.userId),
    check("machines_name_not_empty", sql`length(${table.name}) between 1 and 100`),
    check("machines_credential_version_positive", sql`${table.credentialVersion} > 0`),
    check("machines_lifetime", sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      "machines_one_year_max_lifetime",
      sql`${table.expiresAt} <= ${table.createdAt} + 31536000000`,
    ),
  ],
);

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    slug: text("slug").notNull(),
    displayName: text("display_name").notNull(),
    description: text("description"),
    status: text("status", { enum: ["active", "taken_down"] })
      .notNull()
      .default("active"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("projects_user_slug_unique").on(table.userId, table.slug),
    uniqueIndex("projects_id_user_id_unique").on(table.id, table.userId),
    index("projects_user_id_idx").on(table.userId),
    check("projects_slug_length", sql`length(${table.slug}) between 1 and 41`),
    check("projects_display_name_not_empty", sql`length(${table.displayName}) between 1 and 100`),
    check("projects_status_valid", sql`${table.status} in ('active', 'taken_down')`),
  ],
);

export const hostnameAllocations = sqliteTable(
  "hostname_allocations",
  {
    label: text("label").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("hostname_allocations_project_id_unique").on(table.projectId),
    index("hostname_allocations_user_id_idx").on(table.userId),
    foreignKey({
      columns: [table.projectId, table.userId],
      foreignColumns: [projects.id, projects.userId],
      name: "hostname_allocations_project_owner_fk",
    }),
    check("hostname_allocations_label_length", sql`length(${table.label}) between 6 and 63`),
  ],
);

export const publicationAttempts = sqliteTable(
  "publication_attempts",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    machineId: text("machine_id")
      .notNull()
      .references(() => machines.id),
    state: text("state", { enum: ["open", "expired", "committed", "abandoned"] })
      .notNull()
      .default("open"),
    baseGeneration: integer("base_generation").notNull(),
    baseLogicalBytes: integer("base_logical_bytes").notNull(),
    stagedManifestR2Key: text("staged_manifest_r2_key").notNull(),
    manifestHash: text("manifest_hash").notNull(),
    logicalBytes: integer("logical_bytes").notNull(),
    fileCount: integer("file_count").notNull(),
    reservedActiveDeltaBytes: integer("reserved_active_delta_bytes").notNull(),
    reservedPhysicalUploadBytes: integer("reserved_physical_upload_bytes").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    settledAt: integer("settled_at"),
  },
  (table) => [
    index("publication_attempts_project_state_idx").on(table.projectId, table.state),
    index("publication_attempts_user_state_idx").on(table.userId, table.state),
    index("publication_attempts_machine_id_idx").on(table.machineId),
    uniqueIndex("publication_attempts_identity_unique").on(
      table.id,
      table.projectId,
      table.machineId,
    ),
    foreignKey({
      columns: [table.projectId, table.userId],
      foreignColumns: [projects.id, projects.userId],
      name: "publication_attempts_project_owner_fk",
    }),
    foreignKey({
      columns: [table.machineId, table.userId],
      foreignColumns: [machines.id, machines.userId],
      name: "publication_attempts_machine_owner_fk",
    }),
    check(
      "publication_attempts_state_valid",
      sql`${table.state} in ('open', 'expired', 'committed', 'abandoned')`,
    ),
    check("publication_attempts_base_generation_non_negative", nonNegative(table.baseGeneration)),
    check(
      "publication_attempts_base_logical_bytes_non_negative",
      nonNegative(table.baseLogicalBytes),
    ),
    check("publication_attempts_logical_bytes_non_negative", nonNegative(table.logicalBytes)),
    check("publication_attempts_file_count_non_negative", nonNegative(table.fileCount)),
    check(
      "publication_attempts_reserved_active_delta_non_negative",
      nonNegative(table.reservedActiveDeltaBytes),
    ),
    check(
      "publication_attempts_reserved_physical_upload_non_negative",
      nonNegative(table.reservedPhysicalUploadBytes),
    ),
    check("publication_attempts_expiry", sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      "publication_attempts_settlement",
      sql`(${table.state} = 'open' and ${table.settledAt} is null) or (${table.state} <> 'open' and ${table.settledAt} is not null)`,
    ),
  ],
);

export const publications = sqliteTable(
  "publications",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => publicationAttempts.id),
    generation: integer("generation").notNull(),
    artifactHash: text("artifact_hash").notNull(),
    machineId: text("machine_id")
      .notNull()
      .references(() => machines.id),
    machineNameSnapshot: text("machine_name_snapshot").notNull(),
    logicalBytes: integer("logical_bytes").notNull(),
    physicalBytes: integer("physical_bytes").notNull(),
    fileCount: integer("file_count").notNull(),
    objectCount: integer("object_count").notNull(),
    publishedAt: integer("published_at").notNull(),
  },
  (table) => [
    uniqueIndex("publications_attempt_id_unique").on(table.attemptId),
    uniqueIndex("publications_id_project_id_unique").on(table.id, table.projectId),
    uniqueIndex("publications_project_generation_unique").on(table.projectId, table.generation),
    index("publications_project_published_at_idx").on(table.projectId, table.publishedAt),
    foreignKey({
      columns: [table.attemptId, table.projectId, table.machineId],
      foreignColumns: [
        publicationAttempts.id,
        publicationAttempts.projectId,
        publicationAttempts.machineId,
      ],
      name: "publications_attempt_identity_fk",
    }),
    check("publications_generation_positive", sql`${table.generation} > 0`),
    check("publications_logical_bytes_non_negative", nonNegative(table.logicalBytes)),
    check("publications_physical_bytes_non_negative", nonNegative(table.physicalBytes)),
    check("publications_file_count_non_negative", nonNegative(table.fileCount)),
    check("publications_object_count_non_negative", nonNegative(table.objectCount)),
    check(
      "publications_machine_name_snapshot_not_empty",
      sql`length(${table.machineNameSnapshot}) between 1 and 100`,
    ),
  ],
);

export const projectHeads = sqliteTable(
  "project_heads",
  {
    projectId: text("project_id")
      .primaryKey()
      .references(() => projects.id),
    generation: integer("generation").notNull().default(0),
    publicationId: text("publication_id").references(() => publications.id),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("project_heads_publication_id_unique").on(table.publicationId),
    foreignKey({
      columns: [table.publicationId, table.projectId],
      foreignColumns: [publications.id, publications.projectId],
      name: "project_heads_publication_project_fk",
    }),
    check("project_heads_generation_non_negative", nonNegative(table.generation)),
    check(
      "project_heads_publication_generation_pair",
      sql`(${table.generation} = 0 and ${table.publicationId} is null) or (${table.generation} > 0 and ${table.publicationId} is not null)`,
    ),
  ],
);

export const verifiedObjects = sqliteTable(
  "verified_objects",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    contentHash: text("content_hash").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    verifiedAt: integer("verified_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.contentHash] }),
    check("verified_objects_size_bytes_non_negative", nonNegative(table.sizeBytes)),
  ],
);

export const publicationAttemptObjects = sqliteTable(
  "publication_attempt_objects",
  {
    attemptId: text("attempt_id")
      .notNull()
      .references(() => publicationAttempts.id),
    contentHash: text("content_hash").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    requiresUpload: integer("requires_upload", { mode: "boolean" }).notNull(),
    verified: integer("verified", { mode: "boolean" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.attemptId, table.contentHash] }),
    check("publication_attempt_objects_size_bytes_non_negative", nonNegative(table.sizeBytes)),
    check(
      "publication_attempt_objects_reuse_verified",
      sql`${table.requiresUpload} = 1 or ${table.verified} = 1`,
    ),
  ],
);

export const publicationObjects = sqliteTable(
  "publication_objects",
  {
    publicationId: text("publication_id")
      .notNull()
      .references(() => publications.id),
    contentHash: text("content_hash").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.publicationId, table.contentHash] }),
    check("publication_objects_size_bytes_non_negative", nonNegative(table.sizeBytes)),
  ],
);

export const schema = {
  hostnameAllocations,
  machines,
  projectHeads,
  projects,
  publicationAttemptObjects,
  publicationAttempts,
  publicationObjects,
  publications,
  users,
  verifiedObjects,
};

export type User = typeof users.$inferSelect;
export type Machine = typeof machines.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type HostnameAllocation = typeof hostnameAllocations.$inferSelect;
export type PublicationAttempt = typeof publicationAttempts.$inferSelect;
export type Publication = typeof publications.$inferSelect;
export type ProjectHead = typeof projectHeads.$inferSelect;
export type VerifiedObject = typeof verifiedObjects.$inferSelect;
