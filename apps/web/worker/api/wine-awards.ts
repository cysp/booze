import { siteMemberships, wineAwards, wineVintages, type BoozeDatabase } from "@chikachow/booze-db";
import { and, asc, eq, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";

import { requireSitePermission } from "./auth.ts";
import { generatedId, optionalText } from "./ids.ts";

export type WineAwardInput = {
  readonly id?: string | undefined;
  readonly awardName: string;
  readonly awardLevel: string;
  readonly awardYear?: number | undefined;
  readonly awardBody?: string | undefined;
  readonly category?: string | undefined;
  readonly points?: number | undefined;
  readonly sourceUrl?: string | undefined;
  readonly provenance?: string | undefined;
  readonly notes?: string | undefined;
};

import type { WineAwardResource } from "../../shared/catalogue-resources.ts";
export type { WineAwardResource } from "../../shared/catalogue-resources.ts";

type WineAwardIdentity = Pick<WineAwardResource, "awardName" | "awardLevel" | "awardYear">;

export async function listWineAwards({
  database,
  userId,
  wineVintageId,
}: {
  readonly database: BoozeDatabase;
  readonly userId: string;
  readonly wineVintageId?: string | undefined;
}): Promise<readonly WineAwardResource[]> {
  return database
    .select({
      id: wineAwards.id,
      siteId: wineAwards.siteId,
      wineVintageId: wineAwards.wineVintageId,
      awardName: wineAwards.awardName,
      awardLevel: wineAwards.awardLevel,
      awardYear: wineAwards.awardYear,
      awardBody: wineAwards.awardBody,
      category: wineAwards.category,
      points: wineAwards.points,
      sourceUrl: wineAwards.sourceUrl,
      provenance: wineAwards.provenance,
      notes: wineAwards.notes,
      createdAt: wineAwards.createdAt,
      updatedAt: wineAwards.updatedAt,
    })
    .from(wineAwards)
    .innerJoin(siteMemberships, eq(wineAwards.siteId, siteMemberships.siteId))
    .where(
      and(
        eq(siteMemberships.userId, userId),
        wineVintageId === undefined ? undefined : eq(wineAwards.wineVintageId, wineVintageId),
      ),
    )
    .orderBy(asc(wineAwards.awardYear), asc(wineAwards.awardName), asc(wineAwards.awardLevel));
}

async function assertWineVintageInSite({
  database,
  siteId,
  wineVintageId,
}: {
  readonly database: BoozeDatabase;
  readonly siteId: string;
  readonly wineVintageId: string;
}): Promise<void> {
  const rows = await database
    .select({ id: wineVintages.id })
    .from(wineVintages)
    .where(and(eq(wineVintages.siteId, siteId), eq(wineVintages.id, wineVintageId)))
    .limit(1);
  if (rows[0] === undefined) {
    throw new HTTPException(404, { message: "Wine vintage not found" });
  }
}

export async function replaceWineAwardsForWine({
  awards,
  database,
  siteId,
  userId,
  wineVintageId,
}: {
  readonly awards: readonly WineAwardInput[];
  readonly database: BoozeDatabase;
  readonly siteId: string;
  readonly userId: string;
  readonly wineVintageId: string;
}): Promise<readonly WineAwardResource[]> {
  await requireSitePermission({
    database,
    permission: "site.content.write",
    siteId,
    userId,
  });
  await assertWineVintageInSite({ database, siteId, wineVintageId });

  const [first, ...rest] = await prepareWineAwardStatements({
    awards,
    database,
    siteId,
    userId,
    wineVintageId,
  });
  if (first !== undefined) await database.batch([first, ...rest]);
  return listWineAwards({ database, userId, wineVintageId });
}

export async function prepareWineAwardStatements({
  awards,
  database,
  siteId,
  userId,
  wineVintageId,
  overwriteExisting = true,
  removeMissing = true,
}: {
  readonly overwriteExisting?: boolean;
  readonly removeMissing?: boolean;
  readonly awards: readonly WineAwardInput[];
  readonly database: BoozeDatabase;
  readonly siteId: string;
  readonly userId: string;
  readonly wineVintageId: string;
}): Promise<Parameters<BoozeDatabase["batch"]>[0][number][]> {
  const statements: Parameters<BoozeDatabase["batch"]>[0][number][] = [];
  const keptAwards: WineAwardIdentity[] = [];
  for (const input of awards) {
    const awardName = input.awardName.trim();
    const awardLevel = input.awardLevel.trim();
    if (awardName === "" || awardLevel === "") {
      continue;
    }

    const awardYear = input.awardYear ?? null;
    keptAwards.push({ awardName, awardLevel, awardYear });

    // Resolve the stored ID during the INSERT: nullable years are part of award
    // identity even though SQLite's natural-key constraint treats NULLs as distinct.
    const statement = database.insert(wineAwards).values({
      id: sql`coalesce((
            select id from wine_awards
            where site_id = ${siteId} and wine_vintage_id = ${wineVintageId}
              and award_name = ${awardName} and award_level = ${awardLevel}
              and award_year is ${awardYear}
            order by created_at, id limit 1
          ), ${generatedId("wine-award")})`,
      siteId,
      wineVintageId,
      awardName,
      awardLevel,
      awardYear,
      awardBody: optionalText(input.awardBody),
      category: optionalText(input.category),
      points: input.points,
      sourceUrl: optionalText(input.sourceUrl),
      provenance: optionalText(input.provenance),
      notes: optionalText(input.notes),
      createdByUserId: userId,
    });
    statements.push(
      overwriteExisting
        ? statement.onConflictDoUpdate({
            target: wineAwards.id,
            set: {
              awardName,
              awardLevel,
              awardYear,
              awardBody: optionalText(input.awardBody),
              category: optionalText(input.category),
              points: input.points ?? null,
              sourceUrl: optionalText(input.sourceUrl),
              provenance: optionalText(input.provenance),
              notes: optionalText(input.notes),
              updatedAt: sql`CURRENT_TIMESTAMP`,
            },
          })
        : statement.onConflictDoNothing({ target: wineAwards.id }),
    );
  }

  if (removeMissing) {
    statements.push(
      database.delete(wineAwards).where(
        and(
          eq(wineAwards.siteId, siteId),
          eq(wineAwards.wineVintageId, wineVintageId),
          sql`not exists (
              select 1 from json_each(${JSON.stringify(keptAwards)}) retained
              where ${wineAwards.awardName} = json_extract(retained.value, '$.awardName')
                and ${wineAwards.awardLevel} = json_extract(retained.value, '$.awardLevel')
                and ${wineAwards.awardYear} is json_extract(retained.value, '$.awardYear')
            )`,
        ),
      ),
    );
  }

  return statements;
}
