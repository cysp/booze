// oxlint-disable import/max-dependencies -- MCP composition root registers the complete tool surface.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { createD1Client } from "@chikachow/booze-db";
import { consumeBottle, moveBottle } from "../catalogue-operations.ts";
import { createStorageLocation } from "../location-operations.ts";
import { setDrinkingWindow } from "../wine-operations.ts";
import { assertCanReadStorageLocation, getBottle, withDrinkStatus } from "../api/inventory.ts";
import {
  bottleDetail,
  listBottleSummaries,
  listDrinkQueueBottleSummaries,
  listLocationBottleSummaries,
} from "./bottles.ts";
import { registerCriticReviewTools } from "./critic-reviews.ts";
import {
  getInventorySummary,
  getWineVintageSummary,
  listSites,
  listStorageLocationDisplayNames,
  listStorageLocations,
  listWineVintages,
  listWineries,
  resolveStorageLocationId,
  resolveWineVintageId,
} from "./catalogue.ts";
import { toolJson } from "./pagination.ts";
import {
  bottleDetailSchema,
  bottleSummaryListOutputSchema,
  bottleSummaryOutputSchema,
  createStorageLocationInputSchema,
  createStorageLocationOutputSchema,
  getBottleInputSchema,
  getWineInputSchema,
  inventorySummarySchema,
  listDrinkQueueInputSchema,
  listSitesInputSchema,
  listStorageLocationsInputSchema,
  listWineriesInputSchema,
  listWinesInputSchema,
  markBottleConsumedInputSchema,
  markBottleConsumedOutputSchema,
  locationInventoryInputSchema,
  paginationOutputSchema,
  searchBottlesInputSchema,
  setBottleLocationInputSchema,
  setBottleLocationOutputSchema,
  setDrinkingWindowInputSchema,
  setDrinkingWindowOutputSchema,
  siteSummarySchema,
  storageLocationSummarySchema,
  wineVintageSummarySchema,
  winerySummarySchema,
} from "./schemas.ts";

const MCP_NAME = "booze";
const MCP_VERSION = "0.0.1";

export const boozeMcpToolNames = [
  "cellar.search_bottles",
  "cellar.list_sites",
  "cellar.list_wines",
  "cellar.get_wine",
  "cellar.list_review_sources",
  "cellar.create_review_source",
  "cellar.list_critic_reviews",
  "cellar.upsert_critic_review",
  "cellar.delete_critic_review",
  "cellar.list_wineries",
  "cellar.list_storage_locations",
  "cellar.get_bottle",
  "cellar.list_drink_queue",
  "cellar.list_location_bottles",
  "cellar.get_inventory_summary",
  "cellar.set_drinking_window",
  "cellar.create_storage_location",
  "cellar.set_bottle_location",
  "cellar.mark_bottle_consumed",
] as const;

const readOnlyClosedWorldToolAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: true,
};
const writeClosedWorldToolAnnotations = {
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: false,
};

export function createBoozeMcpServer({
  database,
  userId,
}: {
  readonly database: ReturnType<typeof createD1Client>;
  readonly userId: string;
}): McpServer {
  const server = new McpServer({ name: MCP_NAME, version: MCP_VERSION });

  server.registerTool(
    "cellar.search_bottles",
    {
      annotations: readOnlyClosedWorldToolAnnotations,
      title: "Search bottles",
      description: "Search authorised in-stock wine bottles and return compact bottle summaries.",
      inputSchema: searchBottlesInputSchema,
      outputSchema: bottleSummaryListOutputSchema,
    },
    async (input) => {
      const storageLocationId =
        input.locationId === undefined
          ? undefined
          : await resolveStorageLocationId({ database, locationId: input.locationId, userId });
      const page = await listBottleSummaries({
        database,
        input,
        storageLocationId,
        userId,
      });
      return toolJson({ bottles: page.items, ...page.metadata });
    },
  );

  server.registerTool(
    "cellar.list_sites",
    {
      annotations: readOnlyClosedWorldToolAnnotations,
      title: "List sites",
      description: "List authorised storage sites with bottle and location counts.",
      inputSchema: listSitesInputSchema,
      outputSchema: {
        sites: z.array(siteSummarySchema),
        ...paginationOutputSchema,
      },
    },
    async (input) => {
      const sites = await listSites({ database, input, userId });
      return toolJson({ sites: sites.items, ...sites.metadata });
    },
  );

  server.registerTool(
    "cellar.list_wines",
    {
      annotations: readOnlyClosedWorldToolAnnotations,
      title: "List wines",
      description: "List authorised wine vintages with bottle counts and compact wine details.",
      inputSchema: listWinesInputSchema,
      outputSchema: {
        ...paginationOutputSchema,
        wines: z.array(wineVintageSummarySchema),
      },
    },
    async (input) => {
      const wines = await listWineVintages({ database, input, userId });
      return toolJson({ wines: wines.items, ...wines.metadata });
    },
  );

  server.registerTool(
    "cellar.get_wine",
    {
      annotations: readOnlyClosedWorldToolAnnotations,
      title: "Get wine",
      description: "Fetch one authorised wine vintage by MCP wine ID.",
      inputSchema: getWineInputSchema,
      outputSchema: {
        wine: wineVintageSummarySchema,
        wineId: z.string(),
      },
    },
    async ({ wineId }) => {
      const wine = await getWineVintageSummary({ database, userId, wineId });
      return toolJson({ wine, wineId });
    },
  );

  server.registerTool(
    "cellar.list_wineries",
    {
      annotations: readOnlyClosedWorldToolAnnotations,
      title: "List wineries",
      description: "List authorised wineries with brand names, wine counts, and bottle counts.",
      inputSchema: listWineriesInputSchema,
      outputSchema: {
        ...paginationOutputSchema,
        wineries: z.array(winerySummarySchema),
      },
    },
    async (input) => {
      const wineryRows = await listWineries({ database, input, userId });
      return toolJson({ wineries: wineryRows.items, ...wineryRows.metadata });
    },
  );

  registerCriticReviewTools({
    database,
    readOnlyToolAnnotations: readOnlyClosedWorldToolAnnotations,
    server,
    userId,
    writeToolAnnotations: writeClosedWorldToolAnnotations,
  });

  server.registerTool(
    "cellar.list_storage_locations",
    {
      annotations: readOnlyClosedWorldToolAnnotations,
      title: "List storage locations",
      description:
        "List authorised storage locations with display-ready hierarchical location names and bottle counts.",
      inputSchema: listStorageLocationsInputSchema,
      outputSchema: {
        locations: z.array(storageLocationSummarySchema),
        ...paginationOutputSchema,
      },
    },
    async (input) => {
      const locations = await listStorageLocations({ database, input, userId });
      return toolJson({ locations: locations.items, ...locations.metadata });
    },
  );

  server.registerTool(
    "cellar.get_bottle",
    {
      annotations: readOnlyClosedWorldToolAnnotations,
      title: "Get bottle",
      description: "Fetch one authorised bottle by ID.",
      inputSchema: getBottleInputSchema,
      outputSchema: {
        bottle: bottleDetailSchema,
      },
    },
    async ({ bottleId }) => {
      const storageLocationsById = await listStorageLocationDisplayNames({ database, userId });
      const bottle = bottleDetail({
        bottle: withDrinkStatus(await getBottle({ bottleId, database, userId })),
        storageLocationsById,
      });
      return toolJson({ bottle });
    },
  );

  server.registerTool(
    "cellar.list_drink_queue",
    {
      annotations: readOnlyClosedWorldToolAnnotations,
      title: "List drink queue",
      description:
        "List compact summaries of authorised in-stock bottles by calculated drink status.",
      inputSchema: listDrinkQueueInputSchema,
      outputSchema: bottleSummaryListOutputSchema,
    },
    async (input) => {
      const page = await listDrinkQueueBottleSummaries({ database, input, userId });
      return toolJson({ bottles: page.items, ...page.metadata });
    },
  );

  server.registerTool(
    "cellar.list_location_bottles",
    {
      annotations: readOnlyClosedWorldToolAnnotations,
      title: "List location bottles",
      description:
        "List compact summaries of authorised in-stock bottles for one storage location.",
      inputSchema: locationInventoryInputSchema,
      outputSchema: {
        bottles: z.array(z.object(bottleSummaryOutputSchema)),
        locationId: z.string(),
        ...paginationOutputSchema,
      },
    },
    async ({ locationId, ...input }) => {
      const storageLocationId = await resolveStorageLocationId({ database, locationId, userId });
      await assertCanReadStorageLocation({ database, storageLocationId, userId });
      const page = await listLocationBottleSummaries({
        database,
        input: { locationId, ...input },
        storageLocationId,
        userId,
      });
      return toolJson({ bottles: page.items, locationId, ...page.metadata });
    },
  );

  server.registerTool(
    "cellar.get_inventory_summary",
    {
      annotations: readOnlyClosedWorldToolAnnotations,
      title: "Get inventory summary",
      description:
        "Return compact authorised inventory counts by site, bottle status, and drink status.",
      inputSchema: z.strictObject({}),
      outputSchema: {
        summary: inventorySummarySchema,
      },
    },
    async () => {
      const summary = await getInventorySummary({ database, userId });
      return toolJson({ summary });
    },
  );

  server.registerTool(
    "cellar.set_drinking_window",
    {
      annotations: writeClosedWorldToolAnnotations,
      title: "Set drinking window",
      description:
        "Set an authorised wine vintage's drinking window and return its committed before and after facts.",
      inputSchema: setDrinkingWindowInputSchema,
      outputSchema: setDrinkingWindowOutputSchema.shape,
    },
    async ({ wineId, drinkFromYear, drinkToYear }) =>
      toolJson(
        await setDrinkingWindow({
          context: { database, userId, source: "mcp" },
          wineVintageId: await resolveWineVintageId({ database, userId, wineId }),
          drinkFromYear,
          drinkToYear,
        }),
      ),
  );

  server.registerTool(
    "cellar.create_storage_location",
    {
      annotations: writeClosedWorldToolAnnotations,
      title: "Create storage location",
      description:
        "Create or reuse one location. A name with a different type or multiple existing matches conflicts; update a known location by ID instead.",
      inputSchema: createStorageLocationInputSchema,
      outputSchema: createStorageLocationOutputSchema.shape,
    },
    async ({ siteId, parentStorageLocationId, name, locationType }) =>
      toolJson(
        await createStorageLocation({
          context: { database, userId, source: "mcp" },
          input: {
            siteId,
            parentId:
              parentStorageLocationId === undefined || parentStorageLocationId === null
                ? null
                : await resolveStorageLocationId({
                    database,
                    userId,
                    locationId: parentStorageLocationId,
                  }),
            name,
            locationType,
          },
        }),
      ),
  );

  server.registerTool(
    "cellar.set_bottle_location",
    {
      annotations: writeClosedWorldToolAnnotations,
      title: "Set bottle location",
      description:
        "Move one authorised in-stock bottle or clear its location. Return the committed before and after facts.",
      inputSchema: setBottleLocationInputSchema,
      outputSchema: setBottleLocationOutputSchema.shape,
    },
    async ({ bottleId, storageLocationId, position }) =>
      toolJson(
        setBottleLocationOutputSchema.parse(
          await moveBottle({ database, userId, source: "mcp" }, bottleId, {
            storageLocationId:
              storageLocationId === null
                ? null
                : await resolveStorageLocationId({
                    database,
                    userId,
                    locationId: storageLocationId,
                  }),
            ...(position === undefined ? {} : { positionHint: position }),
          }),
        ),
      ),
  );

  server.registerTool(
    "cellar.mark_bottle_consumed",
    {
      annotations: writeClosedWorldToolAnnotations,
      title: "Mark bottle consumed",
      description:
        "Mark one authorised bottle as consumed, retaining its location history. Return the committed before and after facts.",
      inputSchema: markBottleConsumedInputSchema,
      outputSchema: markBottleConsumedOutputSchema.shape,
    },
    async ({ bottleId }) =>
      toolJson(
        markBottleConsumedOutputSchema.parse(
          await consumeBottle({ database, userId, source: "mcp" }, bottleId),
        ),
      ),
  );
  return server;
}
