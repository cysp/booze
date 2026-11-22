import { mcpToolAuditEvents, type BoozeDatabase, type createD1Client } from "@chikachow/booze-db";
import { z } from "zod";

export const mcpToolAuditEventInputSchema = z.strictObject({
  affectedRecordCount: z.number().int().min(0),
  after: z.record(z.string(), z.unknown()),
  before: z.record(z.string(), z.unknown()),
  input: z.record(z.string(), z.unknown()),
  siteId: z.string().nullable(),
  targetKind: z.enum(["bottle", "capture", "critic_review", "location", "review_source", "wine"]),
  targetMcpId: z.string().min(1),
  targetPersistedId: z.string().min(1),
  toolName: z.string().min(1),
  userId: z.string().min(1),
});

function mcpToolAuditEventValues({
  auditEventId,
  event,
}: {
  readonly auditEventId: string;
  readonly event: z.infer<typeof mcpToolAuditEventInputSchema>;
}): typeof mcpToolAuditEvents.$inferInsert {
  return {
    affectedRecordCount: event.affectedRecordCount,
    afterJson: JSON.stringify(event.after),
    beforeJson: JSON.stringify(event.before),
    id: auditEventId,
    inputJson: JSON.stringify(event.input),
    siteId: event.siteId,
    targetKind: event.targetKind,
    targetMcpId: event.targetMcpId,
    targetPersistedId: event.targetPersistedId,
    toolName: event.toolName,
    userId: event.userId,
  };
}

export function createMcpToolAuditEventInsert({
  auditEventId,
  database,
  event,
}: {
  readonly auditEventId: string;
  readonly database: ReturnType<typeof createD1Client>;
  readonly event: z.infer<typeof mcpToolAuditEventInputSchema>;
}): ReturnType<ReturnType<BoozeDatabase["insert"]>["values"]> {
  return database
    .insert(mcpToolAuditEvents)
    .values(mcpToolAuditEventValues({ auditEventId, event }));
}
