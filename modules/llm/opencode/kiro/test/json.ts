// JSON text of a test's value. Test values are plain data, with no cycles or
// BigInts, so stringify cannot throw.
export const toJson = (value: unknown): string =>
  // oxlint-disable-next-line effecttsgo/global-json -- see above
  JSON.stringify(value);
