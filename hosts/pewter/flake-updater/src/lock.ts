import {
  Array as Arr,
  Effect,
  Hash,
  Option,
  Order,
  Predicate,
  Record as Rec,
  Schema,
  String as Str,
} from "effect";

const Scalar = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]);

const Attrs = Schema.Record(Schema.String, Scalar);

// A node input is either a node key or a `follows` path.
const InputRef = Schema.Union([Schema.String, Schema.Array(Schema.String)]);

const Node = Schema.Struct({
  flake: Schema.optionalKey(Schema.Boolean),
  inputs: Schema.optionalKey(Schema.Record(Schema.String, InputRef)),
  locked: Schema.optionalKey(Attrs),
  original: Schema.optionalKey(Attrs),
  parent: Schema.optionalKey(Schema.Array(Schema.String)),
});

type LockNode = typeof Node.Type;

export class FlakeLock extends Schema.Class<
  FlakeLock,
  { readonly brand: unique symbol }
>("FlakeLock")({
  nodes: Schema.Record(Schema.String, Node),
  root: Schema.String,
  version: Schema.Finite,
}) {}

export class LockParseError extends Schema.TaggedError<
  LockParseError,
  { readonly brand: unique symbol }
>()("LockParseError", { cause: Schema.Defect() }) {}

export const parseLock = Effect.fn("Lock.parseLock")(function* (text: string) {
  return yield* Schema.decodeEffect(Schema.fromJsonString(FlakeLock))(
    text
  ).pipe(Effect.mapError((cause) => LockParseError.make({ cause })));
});

const sortEntries = <A>(entries: [string, A][]) =>
  Arr.sort(
    entries,
    Order.mapInput(Order.String, (entry: [string, A]) => entry[0])
  );

const sortedAttrs = (attrs: typeof Attrs.Type | undefined) =>
  sortEntries(Rec.toEntries(attrs ?? {}));

const describeRef = (
  lock: FlakeLock,
  ref: typeof InputRef.Type | undefined
): string => {
  if (ref === undefined) {
    return "absent";
  }

  if (!Predicate.isString(ref)) {
    return `follows:${Arr.join(ref, "/")}`;
  }

  const node = lock.nodes[ref];

  if (node === undefined) {
    return "missing";
  }

  const inputs = Arr.map(
    sortEntries(Rec.toEntries(node.inputs ?? {})),
    ([name, child]) => [name, describeRef(lock, child)]
  );

  return JSON.stringify([
    sortedAttrs(node.locked),
    sortedAttrs(node.original),
    node.flake ?? true,
    node.parent ?? [],
    inputs,
  ]);
};

const rootInputs = (lock: FlakeLock) => lock.nodes[lock.root]?.inputs ?? {};

// An input's locked node plus everything it pulls in, independent of the node
// keys flake.lock happened to assign. Two inputs are at the same revision when
// these strings are equal.
const identity = (lock: FlakeLock, name: string): string =>
  describeRef(lock, rootInputs(lock)[name]);

export const inputNames = (lock: FlakeLock): readonly string[] =>
  Arr.sort(Rec.keys(rootInputs(lock)), Order.String);

const lockedAttr = (lock: FlakeLock, name: string, attr: string) => {
  const ref = rootInputs(lock)[name];

  if (!Predicate.isString(ref)) {
    return Option.none<string>();
  }

  const value = lock.nodes[ref]?.locked?.[attr];

  return Predicate.isString(value) ? Option.some(value) : Option.none<string>();
};

/** Short revision of a root input, for PR bodies and issues. */
export const shortRev = (lock: FlakeLock, name: string): string => {
  if (!Rec.has(rootInputs(lock), name)) {
    return "absent";
  }

  return lockedAttr(lock, name, "rev").pipe(
    Option.map(Str.slice(0, 7)),
    Option.orElse(() =>
      lockedAttr(lock, name, "narHash").pipe(Option.map(Str.slice(7, 19)))
    ),
    Option.getOrElse(() => "follows")
  );
};

export interface InputChange {
  readonly name: string;
  readonly from: string;
  readonly to: string;
}

/** Whether a root input is at the same revision in both lock files. */
export const sameRevision = (
  a: FlakeLock,
  b: FlakeLock,
  name: string
): boolean => identity(a, name) === identity(b, name);

/**
 * A short digest of a root input's whole lock entry, stable across runs.
 * Equal entries give equal digests, including for inputs without a narHash.
 */
export const entryFingerprint = (lock: FlakeLock, name: string): string =>
  (Hash.string(identity(lock, name)) >>> 0).toString(16);

/** Root inputs whose locked state differs between two lock files. */
export const changedInputs = (
  base: FlakeLock,
  head: FlakeLock
): readonly InputChange[] => {
  const names: string[] = Arr.dedupe([
    ...inputNames(base),
    ...inputNames(head),
  ]);

  return Arr.flatMap(Arr.sort(names, Order.String), (name: string) => {
    if (sameRevision(base, head, name)) {
      return [];
    }

    return [{ name, from: shortRev(base, name), to: shortRev(head, name) }];
  });
};

export interface LockChange {
  /** Every input is either untouched or back at main's revision. */
  readonly onlyReverts: boolean;
  /** Inputs now at main's revision that were not before. */
  readonly reverted: readonly string[];
}

/**
 * Classifies a new flake.lock against the lock it replaced and main's lock.
 * A lock-only commit keeps auto-merge only when it does nothing but put inputs
 * back to the revisions main already runs.
 */
export const classifyLockChange = (
  main: FlakeLock,
  before: FlakeLock,
  after: FlakeLock
): LockChange => {
  const names = inputNames(after);

  const sameInputs =
    after.version === before.version &&
    Arr.join(names, "\n") === Arr.join(inputNames(before), "\n");

  const changed = Arr.filter(
    names,
    (name) => !sameRevision(after, before, name)
  );

  const reverted = Arr.filter(changed, (name) =>
    sameRevision(after, main, name)
  );

  return {
    onlyReverts: sameInputs && reverted.length === changed.length,
    reverted,
  };
};

const freshKey = (nodes: Map<string, LockNode>, wanted: string) => {
  let key = wanted;
  let suffix = 2;

  while (nodes.has(key)) {
    key = `${wanted}_${suffix}`;
    suffix += 1;
  }

  return key;
};

// Copies main's node and its own transitive nodes into `nodes`, renaming
// children whose keys are already taken. `follows` paths name root inputs,
// not node keys, so they carry over unchanged.
const copyChildren = (
  main: FlakeLock,
  node: LockNode,
  nodes: Map<string, LockNode>
): LockNode => {
  if (node.inputs === undefined) {
    return node;
  }

  const inputs = Rec.map(node.inputs, (ref) => {
    if (!Predicate.isString(ref)) {
      return ref;
    }

    const child = main.nodes[ref];

    if (child === undefined) {
      return ref;
    }

    const key = freshKey(nodes, ref);
    nodes.set(key, copyChildren(main, child, nodes));

    return key;
  });

  return { ...node, inputs };
};

const reachable = (nodes: Map<string, LockNode>, root: string) => {
  const seen = new Set<string>();
  const pending = [root];

  while (pending.length > 0) {
    const key = pending.pop();

    if (key !== undefined && !seen.has(key)) {
      seen.add(key);

      for (const ref of Rec.values(nodes.get(key)?.inputs ?? {})) {
        if (Predicate.isString(ref)) {
          pending.push(ref);
        }
      }
    }
  }

  return seen;
};

/**
 * Puts the named root inputs back at main's revisions and leaves every other
 * node exactly as `branch` has it. This is the only way the Flake fixer's
 * requested reverts reach flake.lock.
 */
export const revertInputs = (
  branch: FlakeLock,
  main: FlakeLock,
  names: readonly string[]
): FlakeLock => {
  const nodes = new Map(Rec.toEntries(branch.nodes));
  const branchRoot = rootInputs(branch);
  const mainRoot = rootInputs(main);

  const swaps = Arr.flatMap(names, (name) => {
    const target = branchRoot[name];
    const source = mainRoot[name];

    const sourceNode = Predicate.isString(source)
      ? main.nodes[source]
      : undefined;

    return Predicate.isString(target) && sourceNode !== undefined
      ? [{ target, sourceNode }]
      : [];
  });

  // Drop the branch's versions first so their now-unused children free up
  // their keys before main's children are copied in.
  for (const { target } of swaps) {
    nodes.delete(target);
  }

  const kept = reachable(nodes, branch.root);

  for (const key of nodes.keys()) {
    if (!kept.has(key)) {
      nodes.delete(key);
    }
  }

  for (const { target, sourceNode } of swaps) {
    nodes.set(target, copyChildren(main, sourceNode, nodes));
  }

  return FlakeLock.make({
    nodes: Rec.fromEntries([...nodes.entries()]),
    root: branch.root,
    version: branch.version,
  });
};

const sortRecord = <A>(record: Readonly<Record<string, A>>) =>
  Rec.fromEntries(sortEntries(Rec.toEntries(record)));

const sortOptional = <A>(record: Readonly<Record<string, A>> | undefined) =>
  record === undefined ? undefined : sortRecord(record);

// JSON.stringify drops undefined fields, matching Nix's output for absent keys.
const formatNode = (node: LockNode) => ({
  flake: node.flake,
  inputs: sortOptional(node.inputs),
  locked: sortOptional(node.locked),
  original: sortOptional(node.original),
  parent: node.parent,
});

/** Serializes a lock the way Nix writes flake.lock: sorted keys, 2 spaces. */
export const formatLock = (lock: FlakeLock): string =>
  `${JSON.stringify(
    {
      nodes: Rec.map(sortRecord(lock.nodes), formatNode),
      root: lock.root,
      version: lock.version,
    },
    null,
    2
  )}\n`;
