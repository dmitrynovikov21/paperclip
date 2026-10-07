import { integer, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

/** Survives session-pointer and owner deletion. No content or provider paths. */
export const providerStateScopes = pgTable("provider_state_scopes", {
  id: uuid("id").primaryKey(),
  generation: integer("generation").notNull().default(0),
  currentLeaseId: uuid("current_lease_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
