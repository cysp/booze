import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const currentTimestamp = sql`CURRENT_TIMESTAMP`;
const timestampColumns = {
  createdAt: text("created_at").notNull().default(currentTimestamp),
  updatedAt: text("updated_at")
    .notNull()
    .default(currentTimestamp)
    .$onUpdate(() => currentTimestamp),
};

// Table-level primary keys preserve explicit NOT NULL in Kit RC4 (#6165).
// See docs/drizzle-migrations.md before changing these constraint declarations.
export const users = sqliteTable(
  "users",
  {
    id: text("id").notNull(),
    clerkUserId: text("clerk_user_id").notNull(),
    ...timestampColumns,
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex("users_clerk_user_id_unique").on(table.clerkUserId),
  ],
);

export const sites = sqliteTable(
  "sites",
  {
    id: text("id").notNull(),
    name: text("name").notNull(),
    ...timestampColumns,
  },
  (table) => [primaryKey({ columns: [table.id] })],
);

export const siteMemberships = sqliteTable(
  "site_memberships",
  {
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role").notNull(),
    ...timestampColumns,
  },
  (table) => [
    index("site_memberships_user_id_idx").on(table.userId),
    primaryKey({
      columns: [table.siteId, table.userId],
      name: "site_memberships_site_id_user_id_pk",
    }),
  ],
);

export const wineries = sqliteTable(
  "wineries",
  {
    id: text("id").notNull(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id),
    name: text("name").notNull(),
    addressText: text("address_text"),
    country: text("country"),
    region: text("region"),
    establishedYear: integer("established_year"),
    notes: text("notes"),
    ...timestampColumns,
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("wineries_site_id_idx").on(table.siteId),
    uniqueIndex("wineries_site_id_id_unique").on(table.siteId, table.id),
    uniqueIndex("wineries_site_id_name_region_unique").on(table.siteId, table.name, table.region),
  ],
);

export const wineVintages = sqliteTable(
  "wine_vintages",
  {
    id: text("id").notNull(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id),
    wineryId: text("winery_id"),
    brandName: text("brand_name"),
    baseName: text("base_name").notNull(),
    displayName: text("display_name").notNull(),
    designation: text("designation"),
    vintageYear: integer("vintage_year"),
    vintageStatus: text("vintage_status", { enum: ["year", "non_vintage", "unknown"] })
      .notNull()
      .default("unknown"),
    vintageLabel: text("vintage_label").notNull(),
    wineType: text("wine_type"),
    wineColor: text("wine_color"),
    country: text("country"),
    region: text("region"),
    appellation: text("appellation"),
    classification: text("classification"),
    addressQualification: text("address_qualification"),
    alcoholPercent: real("alcohol_percent"),
    drinkFromYear: integer("drink_from_year"),
    drinkToYear: integer("drink_to_year"),
    description: text("description"),
    drinkingAdvice: text("drinking_advice"),
    labelText: text("label_text"),
    sourceUrl: text("source_url"),
    notes: text("notes"),
    ...timestampColumns,
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("wine_vintages_site_id_idx").on(table.siteId),
    index("wine_vintages_site_id_winery_id_idx").on(table.siteId, table.wineryId),
    uniqueIndex("wine_vintages_site_id_id_unique").on(table.siteId, table.id),
    foreignKey({
      columns: [table.siteId, table.wineryId],
      foreignColumns: [wineries.siteId, wineries.id],
      name: "wine_vintages_site_id_winery_id_wineries_fk",
    }),
  ],
);

export const grapeVarieties = sqliteTable(
  "grape_varieties",
  {
    id: text("id").notNull(),
    name: text("name").notNull(),
    ...timestampColumns,
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex("grape_varieties_name_unique").on(table.name),
  ],
);

export const wineConstituents = sqliteTable(
  "wine_constituents",
  {
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id),
    wineVintageId: text("wine_vintage_id").notNull(),
    grapeVarietyId: text("grape_variety_id")
      .notNull()
      .references(() => grapeVarieties.id),
    blendText: text("blend_text"),
    percentage: real("percentage"),
    ...timestampColumns,
  },
  (table) => [
    index("wine_constituents_grape_variety_id_idx").on(table.grapeVarietyId),
    primaryKey({
      columns: [table.wineVintageId, table.grapeVarietyId],
      name: "wine_constituents_wine_vintage_id_grape_variety_id_pk",
    }),
    foreignKey({
      columns: [table.siteId, table.wineVintageId],
      foreignColumns: [wineVintages.siteId, wineVintages.id],
      name: "wine_constituents_site_id_wine_vintage_id_vintages_fk",
    }),
  ],
);

export const reviewSources = sqliteTable(
  "review_sources",
  {
    id: text("id").notNull(),
    siteId: text("site_id").references(() => sites.id),
    name: text("name").notNull(),
    sourceType: text("source_type").notNull().default("critic"),
    url: text("url"),
    notes: text("notes"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    ...timestampColumns,
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("review_sources_site_id_idx").on(table.siteId),
    uniqueIndex("review_sources_site_id_id_unique").on(table.siteId, table.id),
    uniqueIndex("review_sources_site_id_name_unique").on(table.siteId, table.name),
  ],
);

export const criticReviews = sqliteTable(
  "critic_reviews",
  {
    id: text("id").notNull(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id),
    wineVintageId: text("wine_vintage_id").notNull(),
    reviewSourceId: text("review_source_id")
      .notNull()
      .references(() => reviewSources.id),
    ratingText: text("rating_text").notNull(),
    ratingValue: real("rating_value"),
    ratingScale: text("rating_scale"),
    sourceUrl: text("source_url"),
    reviewedAt: text("reviewed_at"),
    provenance: text("provenance"),
    notes: text("notes"),
    createdByUserId: text("created_by_user_id").references(() => users.id),
    ...timestampColumns,
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("critic_reviews_site_id_wine_vintage_id_idx").on(table.siteId, table.wineVintageId),
    index("critic_reviews_review_source_id_idx").on(table.reviewSourceId),
    uniqueIndex("critic_reviews_site_wine_source_unique").on(
      table.siteId,
      table.wineVintageId,
      table.reviewSourceId,
    ),
    foreignKey({
      columns: [table.siteId, table.wineVintageId],
      foreignColumns: [wineVintages.siteId, wineVintages.id],
      name: "critic_reviews_site_id_wine_vintage_id_vintages_fk",
    }),
  ],
);

export const wineAwards = sqliteTable(
  "wine_awards",
  {
    id: text("id").notNull(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id),
    wineVintageId: text("wine_vintage_id").notNull(),
    awardName: text("award_name").notNull(),
    awardLevel: text("award_level").notNull(),
    awardYear: integer("award_year"),
    awardBody: text("award_body"),
    category: text("category"),
    points: real("points"),
    sourceUrl: text("source_url"),
    provenance: text("provenance"),
    notes: text("notes"),
    createdByUserId: text("created_by_user_id").references(() => users.id),
    ...timestampColumns,
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("wine_awards_site_id_wine_vintage_id_idx").on(table.siteId, table.wineVintageId),
    uniqueIndex("wine_awards_site_wine_award_unique").on(
      table.siteId,
      table.wineVintageId,
      table.awardName,
      table.awardLevel,
      table.awardYear,
    ),
    foreignKey({
      columns: [table.siteId, table.wineVintageId],
      foreignColumns: [wineVintages.siteId, wineVintages.id],
      name: "wine_awards_site_id_wine_vintage_id_vintages_fk",
    }),
  ],
);

export const storageLocations = sqliteTable(
  "storage_locations",
  {
    id: text("id").notNull(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id),
    parentId: text("parent_id"),
    name: text("name").notNull(),
    locationType: text("location_type").notNull().default("area"),
    notes: text("notes"),
    ...timestampColumns,
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("storage_locations_site_id_idx").on(table.siteId),
    uniqueIndex("storage_locations_site_id_id_unique").on(table.siteId, table.id),
    uniqueIndex("storage_locations_site_parent_name_unique").on(
      table.siteId,
      table.parentId,
      table.name,
    ),
    foreignKey({
      columns: [table.siteId, table.parentId],
      foreignColumns: [table.siteId, table.id],
      name: "storage_locations_site_id_parent_id_self_fk",
    }),
  ],
);

export const bottles = sqliteTable(
  "bottles",
  {
    id: text("id").notNull(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id),
    wineVintageId: text("wine_vintage_id").notNull(),
    bottleNumber: text("bottle_number"),
    volumeMl: integer("volume_ml").notNull().default(750),
    barcode: text("barcode"),
    lotCode: text("lot_code"),
    status: text("status").notNull().default("in_stock"),
    acquiredAt: text("acquired_at"),
    purchasePrice: real("purchase_price"),
    purchaseCurrency: text("purchase_currency"),
    notes: text("notes"),
    ...timestampColumns,
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("bottles_site_id_wine_vintage_id_idx").on(table.siteId, table.wineVintageId),
    foreignKey({
      columns: [table.siteId, table.wineVintageId],
      foreignColumns: [wineVintages.siteId, wineVintages.id],
      name: "bottles_site_id_wine_vintage_id_vintages_fk",
    }),
  ],
);

export const bottleLocations = sqliteTable(
  "bottle_locations",
  {
    bottleId: text("bottle_id")
      .notNull()
      .references(() => bottles.id),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id),
    storageLocationId: text("storage_location_id").notNull(),
    positionHint: text("position_hint"),
    updatedAt: text("updated_at").notNull().default(currentTimestamp),
  },
  (table) => [
    primaryKey({ columns: [table.bottleId] }),
    index("bottle_locations_site_id_location_id_idx").on(table.siteId, table.storageLocationId),
    foreignKey({
      columns: [table.siteId, table.storageLocationId],
      foreignColumns: [storageLocations.siteId, storageLocations.id],
      name: "bottle_locations_site_id_storage_location_id_locations_fk",
    }),
  ],
);

export const imageAssets = sqliteTable(
  "image_assets",
  {
    id: text("id").notNull(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id),
    sha256: text("sha256").notNull(),
    r2Key: text("r2_key").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    thumbnailR2Key: text("thumbnail_r2_key"),
    thumbnailContentType: text("thumbnail_content_type"),
    thumbnailSizeBytes: integer("thumbnail_size_bytes"),
    thumbnailWidth: integer("thumbnail_width"),
    thumbnailHeight: integer("thumbnail_height"),
    width: integer("width"),
    height: integer("height"),
    uploadedByUserId: text("uploaded_by_user_id")
      .notNull()
      .references(() => users.id),
    ...timestampColumns,
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("image_assets_site_id_idx").on(table.siteId),
    uniqueIndex("image_assets_r2_key_unique").on(table.r2Key),
  ],
);

export const bottleCaptures = sqliteTable(
  "bottle_captures",
  {
    id: text("id").notNull(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    storageLocationId: text("storage_location_id"),
    positionHint: text("position_hint"),
    quantity: integer("quantity").notNull().default(1),
    status: text("status").notNull().default("queued"),
    workflowInstanceId: text("workflow_instance_id"),
    importedBottleIdsJson: text("imported_bottle_ids_json"),
    reviewCandidateJson: text("review_candidate_json"),
    reviewRevision: integer("review_revision").notNull().default(0),
    errorMessage: text("error_message"),
    errorDetailJson: text("error_detail_json"),
    ...timestampColumns,
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("bottle_captures_site_id_status_idx").on(table.siteId, table.status),
    index("bottle_captures_user_id_idx").on(table.userId),
    foreignKey({
      columns: [table.siteId, table.storageLocationId],
      foreignColumns: [storageLocations.siteId, storageLocations.id],
      name: "bottle_captures_site_id_storage_location_id_locations_fk",
    }),
  ],
);

// Reserves each original's immutable key before R2 can commit it. The upload
// ID is registered here before parts are sent, and survives retries/deletion.
export const captureImageUploads = sqliteTable(
  "capture_image_uploads",
  {
    captureId: text("capture_id")
      .notNull()
      .references(() => bottleCaptures.id),
    sortOrder: integer("sort_order").notNull(),
    writeId: text("write_id").notNull(),
    r2Key: text("r2_key").notNull(),
    uploadId: text("upload_id"),
    sha256: text("sha256").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    originalFilename: text("original_filename"),
    createdAt: text("created_at").notNull().default(currentTimestamp),
  },
  (table) => [
    primaryKey({ columns: [table.captureId, table.sortOrder] }),
    uniqueIndex("capture_image_uploads_write_id_unique").on(table.writeId),
    uniqueIndex("capture_image_uploads_r2_key_unique").on(table.r2Key),
  ],
);

export const bottleCaptureImages = sqliteTable(
  "bottle_capture_images",
  {
    captureId: text("capture_id")
      .notNull()
      .references(() => bottleCaptures.id),
    imageAssetId: text("image_asset_id")
      .notNull()
      .references(() => imageAssets.id),
    sortOrder: integer("sort_order").notNull(),
    originalFilename: text("original_filename"),
    createdAt: text("created_at").notNull().default(currentTimestamp),
  },
  (table) => [
    index("bottle_capture_images_image_asset_id_idx").on(table.imageAssetId),
    primaryKey({
      columns: [table.captureId, table.sortOrder],
      name: "bottle_capture_images_capture_id_sort_order_pk",
    }),
  ],
);

export const bottleCaptureRuns = sqliteTable(
  "bottle_capture_runs",
  {
    id: text("id").notNull(),
    captureId: text("capture_id")
      .notNull()
      .references(() => bottleCaptures.id),
    status: text("status").notNull(),
    extractionR2Key: text("extraction_r2_key"),
    extractionContentType: text("extraction_content_type"),
    extractionSizeBytes: integer("extraction_size_bytes"),
    importCandidateJson: text("import_candidate_json"),
    matchResultJson: text("match_result_json"),
    importResultJson: text("import_result_json"),
    extractorVersion: text("extractor_version").notNull(),
    model: text("model"),
    promptVersion: text("prompt_version").notNull(),
    schemaVersion: text("schema_version").notNull(),
    attemptNumber: integer("attempt_number").notNull().default(1),
    errorMessage: text("error_message"),
    errorDetailR2Key: text("error_detail_r2_key"),
    errorDetailContentType: text("error_detail_content_type"),
    errorDetailSizeBytes: integer("error_detail_size_bytes"),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull().default(currentTimestamp),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("bottle_capture_runs_capture_id_idx").on(table.captureId),
    index("bottle_capture_runs_status_idx").on(table.status),
  ],
);

export const labelExtractions = sqliteTable(
  "label_extractions",
  {
    id: text("id").notNull(),
    bottleId: text("bottle_id").references(() => bottles.id),
    wineVintageId: text("wine_vintage_id").references(() => wineVintages.id),
    captureId: text("capture_id").references(() => bottleCaptures.id),
    captureRunId: text("capture_run_id").references(() => bottleCaptureRuns.id),
    provider: text("provider"),
    model: text("model"),
    rawTextJson: text("raw_text_json"),
    extractedFieldsJson: text("extracted_fields_json").notNull(),
    confidence: real("confidence"),
    requiresReview: integer("requires_review", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull().default(currentTimestamp),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("label_extractions_bottle_id_idx").on(table.bottleId),
    index("label_extractions_wine_vintage_id_idx").on(table.wineVintageId),
    index("label_extractions_capture_id_idx").on(table.captureId),
    index("label_extractions_capture_run_id_idx").on(table.captureRunId),
  ],
);

export const mcpToolAuditEvents = sqliteTable(
  "mcp_tool_audit_events",
  {
    id: text("id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    siteId: text("site_id"),
    toolName: text("tool_name").notNull(),
    targetKind: text("target_kind").notNull(),
    targetMcpId: text("target_mcp_id").notNull(),
    targetPersistedId: text("target_persisted_id").notNull(),
    inputJson: text("input_json").notNull(),
    beforeJson: text("before_json").notNull(),
    afterJson: text("after_json").notNull(),
    affectedRecordCount: integer("affected_record_count").notNull(),
    createdAt: text("created_at").notNull().default(currentTimestamp),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("mcp_tool_audit_events_user_id_created_at_idx").on(table.userId, table.createdAt),
    index("mcp_tool_audit_events_site_id_created_at_idx").on(table.siteId, table.createdAt),
    index("mcp_tool_audit_events_target_idx").on(table.targetKind, table.targetPersistedId),
  ],
);

export const r2ObjectDeletionQueue = sqliteTable(
  "r2_object_deletion_queue",
  {
    r2Key: text("r2_key").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id").notNull(),
    multipartUploadId: text("multipart_upload_id"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    lastAttemptAt: text("last_attempt_at"),
    createdAt: text("created_at").notNull().default(currentTimestamp),
  },
  (table) => [
    primaryKey({ columns: [table.r2Key] }),
    index("r2_object_deletion_queue_attempts_created_at_idx").on(table.attempts, table.createdAt),
  ],
);

// Durable addition identity outlives catalogue deletion. Opaque user/site IDs have
// no foreign keys: replay must never recreate deliberately deleted catalogue rows.
export const additionReceipts = sqliteTable(
  "addition_receipts",
  {
    userId: text("user_id").notNull(),
    kind: text("kind", { enum: ["bottles", "capture"] }).notNull(),
    operationId: text("operation_id").notNull(),
    siteId: text("site_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    resultJson: text("result_json").notNull(),
    createdAt: text("created_at").notNull().default(currentTimestamp),
  },
  (table) => [primaryKey({ columns: [table.userId, table.kind, table.operationId] })],
);
