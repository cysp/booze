import { useState } from "react";

import type { MutationCompletion } from "./useCatalogue.ts";

type NamedResourceKind = "location" | "site";

type NamedResourceDefinition = {
  readonly collectionPath: string;
  readonly deleteSuccessMessage: string;
  readonly label: string;
  readonly title: string;
};

const definitions = {
  location: {
    collectionPath: "/api/storage-locations",
    deleteSuccessMessage: "Location deleted. Bottles stayed in the site without a location.",
    label: "location",
    title: "Location",
  },
  site: {
    collectionPath: "/api/sites",
    deleteSuccessMessage: "Site deleted.",
    label: "site",
    title: "Site",
  },
} as const satisfies Record<NamedResourceKind, NamedResourceDefinition>;

export type NamedResourceEditor = {
  readonly id: string;
  readonly name: string;
};

export type NamedResourceActions = {
  readonly editor: NamedResourceEditor | null;
  readonly beginRename: (id: string, name: string) => void;
  readonly cancelRename: () => void;
  readonly remove: (id: string) => Promise<boolean>;
  readonly saveRename: () => Promise<boolean>;
  readonly setRename: (name: string) => void;
};

export function useNamedResourceActions({
  completeMutation,
  getAuthHeaders,
  kind,
  setStatus,
}: {
  readonly completeMutation: (completion: MutationCompletion) => Promise<void>;
  readonly getAuthHeaders: () => Promise<Record<string, string>>;
  readonly kind: NamedResourceKind;
  readonly setStatus: (status: string) => void;
}): NamedResourceActions {
  const [editor, setEditor] = useState<NamedResourceEditor | null>(null);
  const definition = definitions[kind];

  function beginRename(id: string, name: string): void {
    setEditor({ id, name });
  }

  function cancelRename(): void {
    setEditor(null);
  }

  function setRename(name: string): void {
    setEditor((current) => (current === null ? null : { ...current, name }));
  }

  async function saveRename(): Promise<boolean> {
    if (editor === null) {
      return false;
    }
    if (editor.name.trim() === "") {
      setStatus(`Enter a ${definition.label} name before saving.`);
      return false;
    }
    setStatus(`Updating ${definition.label}...`);
    const response = await fetch(`${definition.collectionPath}/${encodeURIComponent(editor.id)}`, {
      method: "PATCH",
      headers: jsonHeaders(await getAuthHeaders()),
      body: JSON.stringify({ name: editor.name }),
    });
    if (!response.ok) {
      setStatus(`${definition.title} was not updated.`);
      return false;
    }
    setEditor(null);
    await completeMutation({
      refresh: "catalogue",
      successMessage: `${definition.title} updated.`,
    });
    return true;
  }

  async function remove(id: string): Promise<boolean> {
    setStatus(`Deleting ${definition.label}...`);
    const response = await fetch(`${definition.collectionPath}/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: await getAuthHeaders(),
    });
    if (!response.ok) {
      setStatus(`${definition.title} was not deleted.`);
      return false;
    }
    await completeMutation({
      refresh: "catalogue",
      successMessage: definition.deleteSuccessMessage,
    });
    return true;
  }

  return {
    editor,
    beginRename,
    cancelRename,
    remove,
    saveRename,
    setRename,
  };
}

function jsonHeaders(authHeaders: Record<string, string>): Record<string, string> {
  return { "content-type": "application/json", ...authHeaders };
}
