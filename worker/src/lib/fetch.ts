/**
 * `fetch` must be called with the global object as its receiver. Passing the
 * bare function around (into a provider, into a context object) loses that
 * binding and workerd throws "Illegal invocation", so every default is this
 * wrapper rather than the raw global.
 */
export function boundFetch(): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init);
}
