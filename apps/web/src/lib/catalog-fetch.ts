export type CatalogRequestState = 'success' | 'not-found' | 'unavailable' | 'error' | 'network';

export type CatalogResult<T> =
  | { state: 'success'; data: T }
  | { state: Exclude<CatalogRequestState, 'success'> };

/** Keep HTTP and transport failures distinguishable for catalog screens. */
export async function fetchCatalog<T>(url: string): Promise<CatalogResult<T>> {
  try {
    const response = await fetch(url);
    if (response.ok) return { state: 'success', data: (await response.json()) as T };
    if (response.status === 404) return { state: 'not-found' };
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      return { state: 'unavailable' };
    }
    return { state: 'error' };
  } catch {
    return { state: 'network' };
  }
}
