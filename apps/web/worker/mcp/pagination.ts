function toolTextSummary(structuredContent: Record<string, unknown>): string {
  if (
    typeof structuredContent["returnedCount"] === "number" &&
    typeof structuredContent["limit"] === "number"
  ) {
    const nextOffset =
      structuredContent["hasMore"] === true ? ` Use nextPageToken for the next page.` : "";
    return `Returned ${structuredContent["returnedCount"]} matching records with limit ${structuredContent["limit"]}.${nextOffset}`;
  }

  return "Structured result returned.";
}

export function toolJson(structuredContent: Record<string, unknown>): {
  readonly content: { readonly type: "text"; readonly text: string }[];
  readonly structuredContent: Record<string, unknown>;
} {
  return {
    content: [{ type: "text", text: toolTextSummary(structuredContent) }],
    structuredContent,
  };
}
