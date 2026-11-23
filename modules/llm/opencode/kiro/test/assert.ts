// Checks @effect/vitest's assert has no single call for.

import { assert } from "@effect/vitest";
import {
  Array as Arr,
  Predicate,
  Record as Rec,
  type Schema,
  String as Str,
} from "effect";

const isPlainObject = (value: unknown) =>
  Predicate.isObject(value) && !Arr.isArray(value);

// assertSubset checks that actual is an object whose fields named in
// expected are equal to them, and so on into the objects among them, as
// toMatchObject does
export const assertSubset = (
  actual: unknown,
  expected: Readonly<Record<string, Schema.Json | undefined>>,
  path = "the value"
): void => {
  if (!Predicate.isObject(actual)) {
    return assert.fail(`expected ${path} to be an object`);
  }
  for (const [key, want] of Rec.toEntries(expected)) {
    const got = actual[key];
    if (isPlainObject(want) && Predicate.isObject(want)) {
      // SAFETY: a JSON value that is an object and no array is a JSON object
      assertSubset(got, want as Schema.JsonObject, `${path}.${key}`);
    } else {
      assert.deepStrictEqual(got, want, `${path}.${key}`);
    }
  }
};

// assertStartsWith and assertEndsWith check that actual is a string that
// starts or ends with affix, as toStartWith and toEndWith do
export const assertStartsWith = (actual: unknown, affix: string) => {
  assert.isTrue(
    Predicate.isString(actual) && Str.startsWith(affix)(actual),
    `expected ${String(actual)} to start with ${affix}`
  );
};
export const assertEndsWith = (actual: unknown, affix: string) => {
  assert.isTrue(
    Predicate.isString(actual) && Str.endsWith(affix)(actual),
    `expected ${String(actual)} to end with ${affix}`
  );
};

// assertCloseTo checks that actual is a number within 0.005 of expected, as
// toBeCloseTo does
export const assertCloseTo = (actual: unknown, expected: number) => {
  assert.isTrue(
    Predicate.isNumber(actual) && Math.abs(actual - expected) < 0.005,
    `expected ${String(actual)} to be close to ${expected}`
  );
};
