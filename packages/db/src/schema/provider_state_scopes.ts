import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** Survives session-pointer and owner deletion. No content or provider paths. */
export const providerStateScopes = pgTable("provider_state_scopes", {
  id: uuid("id").primaryKey(),
  companyId: uuid("company_id").notNull(),
  agentId: uuid("agent_id").notNull(),
  adapterType: text("adapter_type").notNull(),
  issueId: uuid("issue_id"),
  generation: integer("generation").notNull().default(0),
  currentLeaseId: uuid("current_lease_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  ownerIdx: index("provider_state_scopes_owner_idx").on(table.companyId, table.agentId, table.issueId),
}));
