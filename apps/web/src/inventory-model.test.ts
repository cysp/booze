import { describe, expect, it } from "vitest";

import { bottleCreatePayload, bottleEditPayload, bottleFormSubmission } from "./bottle-payload.ts";
import { formStateForItem, locationLabel, siteLabel } from "./inventory-model.ts";
import { inventoryItemFixture, locationsFixture, sitesFixture } from "./test/catalogue-fixtures.ts";

describe("canonical catalogue resource identity", () => {
  it("disambiguates same site names and same location paths without using those labels as values", () => {
    const firstSite = sitesFixture[0];
    if (firstSite === undefined) throw new Error("Missing site fixture");
    const sites = [firstSite, { ...firstSite, id: "other-site" }];
    const base = locationsFixture[0];
    if (base === undefined) throw new Error("Missing location fixture");
    const locations = [
      base,
      { ...base, id: "duplicate-location" },
      { ...base, id: "other-location", siteId: "other-site" },
    ];
    const options = locations.map((location) => ({
      value: location.id,
      label: `${siteLabel(sites.find((site) => site.id === location.siteId) ?? firstSite, sites)} / ${locationLabel(location, locations)}`,
    }));
    expect(new Set(options.map((option) => option.label)).size).toBe(3);
    expect(options.map((option) => option.value).toSorted()).toEqual([
      "duplicate-location",
      "location-left",
      "other-location",
    ]);
    expect(options.find((option) => option.value === "duplicate-location")?.label).toContain(
      "duplicate-location",
    );
    expect(options.find((option) => option.value === "other-location")?.label).toContain(
      "other-site",
    );
  });
});

describe("structured resource to form submission", () => {
  it("retains numeric facts and literal grape names through an unchanged draft submission", () => {
    const grapeVarieties = [
      "Grenache (Garnacha, Alicante)",
      'Muscat "Blanc"',
      "Chenin / Blanc",
      "日本の品種",
    ];
    const item = inventoryItemFixture({ alcoholPercent: 13.125, volumeMl: 1500, grapeVarieties });
    const form = formStateForItem(item);
    expect(form.alcoholPercent).toBe("13.125");
    expect(form.bottleVolumeMl).toBe("1500");
    expect(form.grapeVarieties).toEqual(grapeVarieties);
    const submission = { kind: "add" as const, form, awards: [], criticReviews: [] };
    expect(bottleCreatePayload(submission)).toMatchObject({
      wine: { grapeVarieties, alcoholPercent: 13.125 },
      bottle: { volumeMl: 1500 },
    });
    const correction = bottleFormSubmission({ kind: "correct-wine", item }, form, {}, "");
    if (correction.kind === "add") throw new Error("Expected wine correction");
    expect(bottleEditPayload(correction, item)).toEqual({});
  });

  it("trims draft entries and removes empty rows while preserving order, case and duplicates", () => {
    const form = {
      ...formStateForItem(inventoryItemFixture()),
      grapeVarieties: ["  Shiraz ", "", "  ", "Grenache", "Shiraz"],
    };
    expect(
      bottleCreatePayload({ kind: "add", form, awards: [], criticReviews: [] }).wine
        ?.grapeVarieties,
    ).toEqual(["Shiraz", "Grenache", "Shiraz"]);
  });
});
