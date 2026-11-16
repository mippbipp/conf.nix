// These functions run inside the X tab through `browse eval`, which sends
// their source text. Effect isn't loaded there, so they may only use their
// arguments and browser globals. browse calls each as (element, arg), and
// element is unset for these calls.
/* oxlint-disable effecttsgo/async-function, effecttsgo/global-fetch, effecttsgo/global-json, effecttsgo/prefer-effect-array, effecttsgo/prefer-effect-record, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof -- see above */

declare const document: {
  readonly cookie: string;
  readonly scripts: Iterable<{ readonly src: string }>;
};

export interface PageRequest {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly bearer: string;
  readonly body: string | null;
  /** Shrink a GraphQL response to the fields decodeBlockedPage reads. */
  readonly prune: boolean;
}

export interface PageResponse {
  readonly status: number;
  readonly text: string;
}

/**
 * Calls X's API as the logged-in account. browse redacts credentials from
 * captured requests, so the CSRF token comes from the page's `ct0` cookie
 * and the web app's public bearer token from its bundle.
 */
export const fetchInPage = async (
  _element: unknown,
  request: PageRequest
): Promise<PageResponse> => {
  const csrf =
    /(?:^|; )ct0=(?<token>[^;]*)/u.exec(document.cookie)?.groups?.token ?? "";

  const response = await fetch(request.url, {
    method: request.method,
    headers: {
      authorization: `Bearer ${request.bearer}`,
      "x-csrf-token": csrf,
      "x-twitter-auth-type": "OAuth2Session",
      "x-twitter-active-user": "yes",
      "content-type":
        request.method === "POST"
          ? "application/x-www-form-urlencoded"
          : "application/json",
    },
    body: request.body,
    credentials: "include",
  });

  const text = await response.text();

  if (!request.prune || response.status !== 200) {
    return { status: response.status, text };
  }

  // A full page is ~4 KB per account and browse cuts results at 100k
  // characters, so only the keys decodeBlockedPage reads come back.
  const keep = new Set([
    "data",
    "viewer",
    "timeline",
    "instructions",
    "entries",
    "content",
    "__typename",
    "itemContent",
    "user_results",
    "result",
    "rest_id",
    "core",
    "screen_name",
    "cursorType",
    "value",
  ]);

  const prune = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(prune);
    }

    if (typeof value !== "object" || value === null) {
      return value;
    }

    const kept = Object.entries(value).filter(([key]) => keep.has(key));

    return Object.fromEntries(kept.map(([key, inner]) => [key, prune(inner)]));
  };

  return { status: 200, text: JSON.stringify(prune(JSON.parse(text))) };
};

/** Finds the bearer token the X web app sends, in its main bundle. */
export const findBearer = async (): Promise<string | null> => {
  const script = Array.from(document.scripts, (entry) => entry.src).find(
    (src) => /\/main\.[^/]*\.js$/u.test(src)
  );

  if (script === undefined) {
    return null;
  }

  const response = await fetch(script);
  const source = await response.text();

  const found = /"Bearer (?<token>AAAAAAAAAAAAAAAAAAAA[A-Za-z0-9%]+)"/u.exec(
    source
  );

  return found?.groups?.token ?? null;
};
