import {
  bottleLocations,
  bottles,
  sites,
  storageLocations,
  wineries,
  wineVintages,
} from "@chikachow/booze-db";
import { or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { storedVintageLabel } from "./wine-vintage.ts";

// D1 lower() folds ASCII only. Other Unicode text remains a literal,
// case-sensitive substring. instr keeps %, _ and quotes literal as well.
function contains(expression: SQLWrapper, query: string): SQL {
  return sql`instr(lower(coalesce(${expression}, '')), lower(${query})) > 0`;
}

function wineTextFields(): readonly SQLWrapper[] {
  return [
    sites.name,
    wineries.name,
    wineVintages.brandName,
    wineVintages.baseName,
    wineVintages.designation,
    wineVintages.displayName,
    storedVintageLabel,
    wineVintages.vintageYear,
    wineVintages.country,
    wineVintages.region,
    wineVintages.appellation,
    wineVintages.classification,
    wineVintages.wineType,
    wineVintages.wineColor,
    wineVintages.addressQualification,
    wineVintages.alcoholPercent,
    wineVintages.drinkFromYear,
    wineVintages.drinkToYear,
    wineVintages.description,
    wineVintages.drinkingAdvice,
    wineVintages.labelText,
    wineVintages.sourceUrl,
    wineVintages.notes,
  ];
}

export function wineTextSearch(query: string | undefined): SQL | undefined {
  if (query === undefined || query === "") return undefined;
  return or(
    ...wineTextFields().map((field) => contains(field, query)),
    sql`exists (
      select 1 from wine_constituents constituent
      join grape_varieties grape on grape.id = constituent.grape_variety_id
      where constituent.site_id = ${wineVintages.siteId}
        and constituent.wine_vintage_id = ${wineVintages.id}
        and ${contains(sql`grape.name`, query)}
    )`,
    sql`exists (
      select 1 from critic_reviews review join review_sources source on source.id = review.review_source_id
      where review.site_id = ${wineVintages.siteId} and review.wine_vintage_id = ${wineVintages.id}
        and (${or(
          ...[
            sql`source.name || ': ' || review.rating_text`,
            sql`review.rating_value`,
            sql`review.rating_scale`,
            sql`review.source_url`,
            sql`review.reviewed_at`,
            sql`review.provenance`,
            sql`review.notes`,
          ].map((field) => contains(field, query)),
        )})
    )`,
    sql`exists (
      select 1 from wine_awards award
      where award.site_id = ${wineVintages.siteId} and award.wine_vintage_id = ${wineVintages.id}
        and (${or(
          ...[
            sql`award.award_name`,
            sql`award.award_level`,
            sql`award.award_year`,
            sql`award.award_body`,
            sql`award.category`,
            sql`award.points`,
            sql`award.source_url`,
            sql`award.provenance`,
            sql`award.notes`,
            sql`award.award_level || ' - ' || coalesce(award.award_year || ' - ', '') || award.award_name`,
          ].map((field) => contains(field, query)),
        )})
    )`,
  );
}

// Traverse only this bottle's location chain. JSON membership makes the cycle
// guard independent of characters in opaque IDs and names containing slashes.
function locationPathExpression(): SQL<string> {
  return sql<string>`coalesce((
    with recursive ancestors(id, parent_id, path, visited, depth) as (
      select location.id, location.parent_id, location.name, json_array(location.id), 0
      from storage_locations location
      where location.site_id = ${bottles.siteId} and location.id = ${storageLocations.id}
      union all
      select parent.id, parent.parent_id, parent.name || ' / ' || ancestors.path,
        json_insert(ancestors.visited, '$[#]', parent.id), ancestors.depth + 1
      from storage_locations parent join ancestors on parent.id = ancestors.parent_id
      where parent.site_id = ${bottles.siteId}
        and not exists (select 1 from json_each(ancestors.visited) where value = parent.id)
    ) select path from ancestors order by depth desc limit 1
  ), 'No storage location')`;
}

export function bottleTextSearch(query: string | undefined): SQL | undefined {
  if (query === undefined || query === "") return undefined;
  return or(
    wineTextSearch(query),
    ...[
      locationPathExpression(),
      bottleLocations.positionHint,
      bottles.bottleNumber,
      bottles.volumeMl,
      bottles.barcode,
      bottles.lotCode,
      bottles.notes,
    ].map((field) => contains(field, query)),
  );
}
