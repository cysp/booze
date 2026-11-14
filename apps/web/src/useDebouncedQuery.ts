import { useEffect, useState } from "react";

/** Keep text input immediate while grouping rapid edits into one server search. */
export function useDebouncedQuery(value: string): string {
  const [query, setQuery] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(value);
    }, 200);
    return () => {
      clearTimeout(timer);
    };
  }, [value]);
  return query;
}
