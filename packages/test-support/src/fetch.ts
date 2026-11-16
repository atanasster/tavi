/**
 * A `fetch` a test scripts: each call is answered by `answer`, given the URL
 * as a string (whether it was asked for by string, `URL` or `Request`) and
 * the request's init. Typed as the real `fetch`, so it is passed wherever a
 * fetch is injected without a cast.
 */
export function fakeFetch(answer: (url: string, init: RequestInit | undefined) => Response | Promise<Response>): typeof fetch {
  return async (input, init) => await answer(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, init);
}
