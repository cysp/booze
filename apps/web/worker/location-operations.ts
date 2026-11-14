import { bottleCaptures, bottleLocations, storageLocations } from "@chikachow/booze-db";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { entityIdSchema } from "../shared/entity-id.ts";

import { requireSitePermission } from "./api/auth.ts";
import { generatedId } from "./api/ids.ts";
import {
  commitOperation,
  createOperationAudit,
  operationAuditResultSchema,
  type OperationContext,
} from "./operation-transaction.ts";

export const createStorageLocationInputSchema = z.strictObject({
  siteId: entityIdSchema,
  parentId: entityIdSchema.nullable().default(null),
  name: z.string().trim().min(1).max(120),
  locationType: z.string().trim().min(1).max(40).default("area"),
});

export const updateStorageLocationInputSchema = z.strictObject({
  parentId: entityIdSchema.nullable().optional(),
  name: z.string().trim().min(1).max(120).optional(),
  locationType: z.string().trim().min(1).max(40).optional(),
  notes: z.string().trim().max(2_000).nullable().optional(),
});

const storageLocationSnapshotSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  parentId: z.string().nullable(),
  name: z.string(),
  locationType: z.string(),
  notes: z.string().nullable(),
});

export type StorageLocationSnapshot = z.infer<typeof storageLocationSnapshotSchema>;

export async function createStorageLocation({
  context,
  input,
}: {
  readonly context: OperationContext;
  readonly input: z.input<typeof createStorageLocationInputSchema>;
}): Promise<{
  readonly before: StorageLocationSnapshot | null;
  readonly after: StorageLocationSnapshot;
  readonly changed: boolean;
  readonly affectedRecordCount: number;
}> {
  const payload = createStorageLocationInputSchema.parse(input);
  const { database, userId } = context;
  const { siteId, parentId, name, locationType } = payload;
  await requireSitePermission({ database, permission: "site.content.write", siteId, userId });

  const matching = sql`site_id = ${siteId} and parent_id is ${parentId} and name = ${name}`;
  const matchingCount = sql`(select count(*) from storage_locations where ${matching})`;
  const storageLocationId = sql<string>`coalesce(
    (select id from storage_locations where ${matching} and ${matchingCount} = 1),
    ${generatedId("loc")}
  )`;
  const rejection = sql<string | null>`case
    when ${parentId} is not null and not exists (
      select 1 from storage_locations where id = ${parentId} and site_id = ${siteId}
    ) then 'parent'
    when ${matchingCount} > 1 then 'ambiguous'
    when exists (select 1 from storage_locations where ${matching} and location_type != ${locationType})
      then 'type'
    else null end`;
  const audit = createOperationAudit({
    context,
    siteId,
    action: "cellar.create_storage_location",
    targetKind: "location",
    targetId: storageLocationId,
    input: payload,
    before: sql`coalesce(${locationSnapshot(storageLocationId)}, 'null')`,
    condition: sql`(${rejection}) is null`,
  });
  const committedId = auditTargetId(audit.id);
  const results = await commitOperation(context, siteId, [
    database.select({ rejection }).from(sql`(select 1)`),
    audit.begin,
    // The lookup and insert share the transaction. NULL parents therefore need
    // no new unique index, which would reject historical duplicate root rows.
    database.insert(storageLocations).select(sql`
      select ${committedId}, ${siteId}, ${parentId}, ${name}, ${locationType}, null,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      where exists (select 1 from mcp_tool_audit_events where id = ${audit.id})
        and not exists (select 1 from storage_locations where ${matching})
    `),
    audit.finish(locationSnapshot(committedId)),
    audit.read,
  ]);
  rejectLocationMutation(results[1][0]?.rejection);
  const event = z.array(operationAuditResultSchema).parse(results.at(-1))[0];
  if (event === undefined) throw new Error("Storage location creation did not return an audit");
  const before = storageLocationSnapshotSchema.nullable().parse(JSON.parse(event.beforeJson));
  const after = storageLocationSnapshotSchema.parse(JSON.parse(event.afterJson));
  return {
    before,
    after,
    changed: event.affectedRecordCount !== 0,
    affectedRecordCount: event.affectedRecordCount,
  };
}

export async function updateStorageLocation({
  context,
  storageLocationId,
  input,
}: {
  readonly context: OperationContext;
  readonly storageLocationId: string;
  readonly input: z.input<typeof updateStorageLocationInputSchema>;
}): Promise<{
  readonly before: StorageLocationSnapshot;
  readonly after: StorageLocationSnapshot;
  readonly changed: boolean;
  readonly affectedRecordCount: number;
}> {
  const payload = updateStorageLocationInputSchema.parse(input);
  const { database } = context;
  const siteId = await locationSiteId({ context, storageLocationId });
  const parentId =
    payload.parentId === undefined
      ? sql`(select parent_id from storage_locations where id = ${storageLocationId})`
      : sql`${payload.parentId}`;
  const name =
    payload.name === undefined
      ? sql`(select name from storage_locations where id = ${storageLocationId})`
      : sql`${payload.name}`;
  const rejection = sql<string | null>`case
    when not exists (select 1 from storage_locations where id = ${storageLocationId} and site_id = ${siteId})
      then 'missing'
    when ${parentId} is not null and not (${validParentCondition({ parentId, siteId, storageLocationId })})
      then 'parent'
    when (select parent_id is not ${parentId} or name is not ${name}
      from storage_locations where id = ${storageLocationId})
      and exists (select 1 from storage_locations where site_id = ${siteId}
        and parent_id is ${parentId} and name = ${name} and id != ${storageLocationId})
      then 'duplicate'
    else null end`;
  const audit = createOperationAudit({
    context,
    siteId,
    action: "cellar.update_storage_location",
    targetKind: "location",
    targetId: storageLocationId,
    input: { storageLocationId, ...payload },
    before: locationSnapshot(sql`${storageLocationId}`),
    condition: sql`(${rejection}) is null`,
  });
  const changed = sql`(
    ${payload.parentId === undefined ? sql`0` : sql`${storageLocations.parentId} is not ${payload.parentId}`}
    or ${payload.name === undefined ? sql`0` : sql`${storageLocations.name} is not ${payload.name}`}
    or ${payload.locationType === undefined ? sql`0` : sql`${storageLocations.locationType} is not ${payload.locationType}`}
    or ${payload.notes === undefined ? sql`0` : sql`${storageLocations.notes} is not ${payload.notes}`}
  )`;
  const results = await commitOperation(context, siteId, [
    database.select({ rejection }).from(sql`(select 1)`),
    audit.begin,
    database
      .update(storageLocations)
      .set({ ...payload, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(
        and(
          eq(storageLocations.id, storageLocationId),
          sql`exists (select 1 from mcp_tool_audit_events where id = ${audit.id})`,
          changed,
        ),
      ),
    audit.finish(locationSnapshot(sql`${storageLocationId}`)),
    audit.read,
  ]);
  rejectLocationMutation(results[1][0]?.rejection);
  const event = z.array(operationAuditResultSchema).parse(results.at(-1))[0];
  if (event === undefined) throw new Error("Storage location update did not return an audit");
  return {
    before: storageLocationSnapshotSchema.parse(JSON.parse(event.beforeJson)),
    after: storageLocationSnapshotSchema.parse(JSON.parse(event.afterJson)),
    changed: event.affectedRecordCount !== 0,
    affectedRecordCount: event.affectedRecordCount,
  };
}

const locationDeletionSnapshotSchema = z.object({
  location: storageLocationSnapshotSchema.nullable(),
  bottleLocations: z.array(
    z.object({
      bottleId: z.string(),
      storageLocationId: z.string(),
      positionHint: z.string().nullable(),
    }),
  ),
  captures: z.array(
    z.object({
      id: z.string(),
      storageLocationId: z.string().nullable(),
      positionHint: z.string().nullable(),
    }),
  ),
  children: z.array(z.object({ id: z.string(), parentId: z.string().nullable() })),
});

export async function deleteStorageLocation({
  context,
  storageLocationId,
}: {
  readonly context: OperationContext;
  readonly storageLocationId: string;
}): Promise<{
  readonly before: z.infer<typeof locationDeletionSnapshotSchema>;
  readonly after: z.infer<typeof locationDeletionSnapshotSchema>;
  readonly changed: boolean;
  readonly affectedRecordCount: number;
}> {
  const { database } = context;
  const siteId = await locationSiteId({ context, storageLocationId });
  const audit = createOperationAudit({
    context,
    siteId,
    action: "cellar.delete_storage_location",
    targetKind: "location",
    targetId: storageLocationId,
    input: { storageLocationId },
    before: locationDeletionSnapshot({ storageLocationId }),
    condition: sql`exists (select 1 from storage_locations where id = ${storageLocationId} and site_id = ${siteId})`,
  });
  const mayWrite = sql`exists (select 1 from mcp_tool_audit_events where id = ${audit.id})`;
  const results = await commitOperation(context, siteId, [
    audit.begin,
    database
      .delete(bottleLocations)
      .where(and(eq(bottleLocations.storageLocationId, storageLocationId), mayWrite)),
    database
      .update(bottleCaptures)
      .set({ storageLocationId: null, positionHint: null, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(and(eq(bottleCaptures.storageLocationId, storageLocationId), mayWrite)),
    database
      .update(storageLocations)
      .set({ parentId: null, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(and(eq(storageLocations.parentId, storageLocationId), mayWrite)),
    database
      .delete(storageLocations)
      .where(and(eq(storageLocations.id, storageLocationId), mayWrite)),
    audit.finish(
      locationDeletionSnapshot({ storageLocationId, auditId: audit.id }),
      sql`1 + json_array_length(before_json, '$.bottleLocations')
        + json_array_length(before_json, '$.captures') + json_array_length(before_json, '$.children')`,
    ),
    audit.read,
  ]);
  const event = z.array(operationAuditResultSchema).parse(results.at(-1))[0];
  if (event === undefined) throw new HTTPException(404, { message: "Storage location not found" });
  return {
    before: locationDeletionSnapshotSchema.parse(JSON.parse(event.beforeJson)),
    after: locationDeletionSnapshotSchema.parse(JSON.parse(event.afterJson)),
    changed: true,
    affectedRecordCount: event.affectedRecordCount,
  };
}

function locationSnapshot(storageLocationId: SQL): SQL {
  return sql`(select json_object(
    'id', id, 'siteId', site_id, 'parentId', parent_id,
    'name', name, 'locationType', location_type, 'notes', notes
  ) from storage_locations where id = ${storageLocationId})`;
}

function locationDeletionSnapshot({
  storageLocationId,
  auditId,
}: {
  readonly storageLocationId: string;
  readonly auditId?: string;
}): SQL {
  const captures =
    auditId === undefined
      ? sql`storage_location_id = ${storageLocationId}`
      : sql`id in (select json_extract(value, '$.id') from json_each(
      (select before_json from mcp_tool_audit_events where id = ${auditId}), '$.captures'
    ))`;
  const children =
    auditId === undefined
      ? sql`parent_id = ${storageLocationId}`
      : sql`id in (select json_extract(value, '$.id') from json_each(
      (select before_json from mcp_tool_audit_events where id = ${auditId}), '$.children'
    ))`;
  return sql`json_object(
    'location', json(${locationSnapshot(sql`${storageLocationId}`)}),
    'bottleLocations', json((select json_group_array(json_object(
      'bottleId', bottle_id, 'storageLocationId', storage_location_id, 'positionHint', position_hint
    )) from (select * from bottle_locations where storage_location_id = ${storageLocationId} order by bottle_id))),
    'captures', json((select json_group_array(json_object(
      'id', id, 'storageLocationId', storage_location_id, 'positionHint', position_hint
    )) from (select * from bottle_captures where ${captures} order by id))),
    'children', json((select json_group_array(json_object('id', id, 'parentId', parent_id))
      from (select id, parent_id from storage_locations where ${children} order by id)))
  )`;
}

function auditTargetId(auditId: string): SQL<string> {
  return sql<string>`(select target_persisted_id from mcp_tool_audit_events where id = ${auditId})`;
}

function validParentCondition({
  parentId,
  siteId,
  storageLocationId,
}: {
  readonly parentId: SQL;
  readonly siteId: string;
  readonly storageLocationId: string;
}): SQL {
  return sql`exists (select 1 from storage_locations where id = ${parentId} and site_id = ${siteId})
    and not exists (
      with recursive ancestors(id, parent_id) as (
        select id, parent_id from storage_locations where id = ${parentId} and site_id = ${siteId}
        union
        select parent.id, parent.parent_id from storage_locations parent
        join ancestors on parent.id = ancestors.parent_id where parent.site_id = ${siteId}
      )
      select 1 from ancestors where id = ${storageLocationId}
    )`;
}

async function locationSiteId({
  context: { database, userId },
  storageLocationId,
}: {
  readonly context: OperationContext;
  readonly storageLocationId: string;
}): Promise<string> {
  const rows = await database
    .select({ siteId: storageLocations.siteId })
    .from(storageLocations)
    .where(eq(storageLocations.id, storageLocationId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) throw new HTTPException(404, { message: "Storage location not found" });
  await requireSitePermission({
    database,
    permission: "site.content.write",
    siteId: row.siteId,
    userId,
  });
  return row.siteId;
}

function rejectLocationMutation(rejection: string | null | undefined): void {
  if (rejection === "missing")
    throw new HTTPException(404, { message: "Storage location not found" });
  if (rejection === "parent")
    throw new HTTPException(400, {
      message: "Parent location must belong to the same site and cannot create a cycle",
    });
  if (rejection === "ambiguous")
    throw new HTTPException(409, {
      message: "More than one storage location has this parent and name; choose a location by ID",
    });
  if (rejection === "type")
    throw new HTTPException(409, {
      message: "Storage location has a different type; update the location by ID",
    });
  if (rejection === "duplicate")
    throw new HTTPException(409, {
      message: "Another storage location already has this parent and name",
    });
}
