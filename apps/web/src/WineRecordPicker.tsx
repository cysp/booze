import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useEffect, useState, type ReactElement } from "react";
import { wineDetailResponseSchema, wineOptionsPageSchema } from "../shared/wine-resources.ts";
import { wineOptionLabel, type WineOption } from "../shared/wine-options.ts";
import { useDebouncedQuery } from "./useDebouncedQuery.ts";
import { useReadPage, type AuthHeadersProvider } from "./useReadPage.ts";

export function WineRecordPicker({
  siteId,
  selected,
  onChange,
  getAuthHeaders,
  excludedId,
  label,
  disabled = false,
  allowNew = false,
}: {
  readonly siteId: string;
  readonly selected: string;
  readonly onChange: (id: string, option: WineOption | undefined) => void;
  readonly getAuthHeaders: AuthHeadersProvider;
  readonly excludedId?: string | undefined;
  readonly label: string;
  readonly disabled?: boolean;
  readonly allowNew?: boolean;
}): ReactElement {
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<WineOption | undefined>();
  const [selectedError, setSelectedError] = useState(false);
  const [selectedRetry, setSelectedRetry] = useState(0);
  const settledQuery = useDebouncedQuery(query);
  const parameters = new URLSearchParams({ siteId, query: settledQuery, limit: "50" });
  const read = useReadPage({
    active: siteId !== "",
    getAuthHeaders,
    path: `/api/wines?${parameters.toString()}`,
    schema: wineOptionsPageSchema,
  });
  const options = (read.page?.data ?? []).filter(
    (wine) => wine.siteId === siteId && wine.wineVintageId !== excludedId,
  );
  const hasSelected = options.some((wine) => wine.wineVintageId === selected);
  useEffect(() => {
    let current = true;
    if (
      selected !== "" &&
      !hasSelected &&
      !(chosen?.wineVintageId === selected && chosen.siteId === siteId)
    ) {
      void (async () => {
        try {
          const response = await fetch(`/api/wines/${encodeURIComponent(selected)}`, {
            headers: await getAuthHeaders(),
          });
          if (!response.ok) throw new Error("Wine unavailable");
          const { data } = wineDetailResponseSchema.parse(await response.json());
          if (current) {
            if (data.siteId === siteId && data.id === selected) {
              setChosen({ ...data, wineVintageId: data.id });
              setSelectedError(false);
            } else setSelectedError(true);
          }
        } catch {
          if (current) setSelectedError(true);
        }
      })();
    }
    return () => {
      current = false;
    };
  }, [chosen, getAuthHeaders, hasSelected, selected, selectedRetry, siteId]);
  if (
    chosen !== undefined &&
    chosen.siteId === siteId &&
    chosen.wineVintageId === selected &&
    !options.some((wine) => wine.wineVintageId === selected)
  )
    options.push(chosen);
  return (
    <div>
      <TextInput label="Search wine records" autoComplete="off" value={query} onChange={setQuery} />
      <Selector
        label={label}
        value={selected}
        isDisabled={disabled || siteId === ""}
        placeholder="Choose an existing wine"
        description="Choose a wine explicitly, or create a separate record. Similar details never merge wine records."
        options={[
          ...(allowNew ? [{ value: "", label: "Create a separate wine record" }] : []),
          ...options.map((wine) => ({
            value: wine.wineVintageId,
            label: wineOptionLabel(wine),
            description: wine.wineVintageId,
          })),
        ]}
        onChange={(id: string) => {
          const wine = options.find((option) => option.wineVintageId === id);
          setChosen(wine);
          setSelectedError(false);
          onChange(id, wine);
        }}
      />
      {selectedError ? (
        <Banner
          status="warning"
          title="Selected wine could not be loaded."
          endContent={
            <Button
              label="Retry selected wine"
              onClick={() => {
                setSelectedRetry((value) => value + 1);
              }}
            />
          }
        />
      ) : null}
      {read.error === null ? null : (
        <Banner
          status="warning"
          title="Wine records could not be refreshed."
          endContent={
            <Button
              label="Retry wine records"
              clickAction={async () => {
                try {
                  await read.refresh();
                } catch {
                  /* The picker retains its warning. */
                }
              }}
            />
          }
        />
      )}
      {read.page?.nextPageToken === null || read.page === null ? null : (
        <Button
          label="Load more wine records"
          isLoading={read.isRefreshing}
          clickAction={async () => {
            try {
              await read.loadMore();
            } catch {
              /* The picker retains its warning. */
            }
          }}
        />
      )}
    </div>
  );
}
