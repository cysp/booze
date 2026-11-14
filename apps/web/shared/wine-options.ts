import { z } from "zod";

const text = z.string();
const number = z.number();
const nullableText = text.nullable();
const nullableNumber = number.nullable();

export const wineOptionSchema = z
  .object({
    wineVintageId: text,
    siteId: text,
    displayName: text,
    wineryName: text,
    grapeVarieties: z.array(text).readonly(),
    vintageYear: nullableNumber,
    vintageStatus: z.enum(["year", "non_vintage", "unknown"]),
    vintageLabel: text,
    region: nullableText,
  })
  .readonly();

export type WineOption = z.infer<typeof wineOptionSchema>;

export function isWineOption(value: unknown): value is WineOption {
  return wineOptionSchema.safeParse(value).success;
}

export function wineOptionLabel(wine: WineOption): string {
  return [wine.vintageStatus === "unknown" ? "" : wine.vintageLabel, wine.displayName]
    .filter(Boolean)
    .join(" ");
}
