/**
 * The Search page's URL: /search?q=<query>. Shared by server pages and client
 * components, so it lives outside any "use client" module.
 */
export const SEARCH_PATH = "/search";
export const QUERY_PARAM = "q";

export function searchHref(query: string): string {
  return `${SEARCH_PATH}?${new URLSearchParams({ [QUERY_PARAM]: query })}`;
}
