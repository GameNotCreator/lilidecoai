/**
 * A minimal in-memory collection for the credit and usage tests.
 *
 * Only the operators those modules use are implemented, and every mutation
 * runs to completion synchronously before the promise resolves — that is what
 * makes the concurrency test meaningful: ten `reserveCredit` calls interleave
 * at their `await` points exactly as they would against MongoDB's
 * single-document atomicity, and only one may take the last credit.
 *
 * Dotted update paths (`usageTotals.calls`) write through to nested objects,
 * as MongoDB does, so a test cannot pass on a literal dotted key.
 */
type Row = Record<string, unknown>;

/** Narrows a value that must be a nested document at this point. */
function asRow(value: unknown): Row {
  return value as Row;
}

function value(row: Row, path: string): unknown {
  if (!path.includes(".")) return row[path];
  const [head, ...rest] = path.split(".");
  const target = row[head as string];
  const tail = rest.join(".");
  if (Array.isArray(target)) return target.map((item) => asRow(item)[tail]);
  if (target && typeof target === "object") return value(asRow(target), tail);
  return undefined;
}

/** Writes through a dotted path, creating intermediate objects. */
function setPath(
  row: Row,
  path: string,
  mutate: (current: unknown) => unknown,
): void {
  const segments = path.split(".");
  let target = row;
  for (const segment of segments.slice(0, -1)) {
    if (!target[segment] || typeof target[segment] !== "object") {
      target[segment] = {};
    }
    target = asRow(target[segment]);
  }
  const last = segments[segments.length - 1] as string;
  target[last] = mutate(target[last]);
}

function matchesOperator(
  actual: unknown,
  op: string,
  expected: unknown,
): boolean {
  const values = Array.isArray(actual) ? actual : [actual];
  switch (op) {
    case "$gt":
      return values.some((item) => (item as number) > (expected as number));
    case "$lt":
      return values.some((item) => (item as number) < (expected as number));
    case "$nin":
      return values.every((item) => !(expected as unknown[]).includes(item));
    case "$gte":
      return values.some((item) => (item as number) >= (expected as number));
    case "$lte":
      return values.some((item) => (item as number) <= (expected as number));
    case "$ne":
      return !values.includes(expected);
    case "$in":
      return values.some((item) => (expected as unknown[]).includes(item));
    case "$exists":
      return (actual !== undefined) === expected;
    default:
      throw new Error(`Unsupported test operator ${op}`);
  }
}

function matches(row: Row, filter: Row): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or")
      return (expected as Row[]).some((part) => matches(row, part));
    if (key === "$and")
      return (expected as Row[]).every((part) => matches(row, part));
    const actual = value(row, key);
    if (expected instanceof Date)
      return actual instanceof Date && actual.getTime() === expected.getTime();
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      return Object.entries(expected as Row).every(([op, operand]) =>
        matchesOperator(actual, op, operand),
      );
    }
    if (Array.isArray(actual)) return actual.includes(expected);
    return actual === expected;
  });
}

function apply(row: Row, update: Row): void {
  for (const [field, delta] of Object.entries(asRow(update.$inc ?? {}))) {
    setPath(
      row,
      field,
      (current) => ((current as number) ?? 0) + (delta as number),
    );
  }
  for (const [field, item] of Object.entries(asRow(update.$push ?? {}))) {
    // `{ $each, $slice }` bounds an array, as `processedKeys` needs.
    const spec = item as { $each?: unknown[]; $slice?: number };
    const additions = spec && spec.$each ? spec.$each : [item];
    setPath(row, field, (current) => {
      const next = [...((current as unknown[]) ?? []), ...additions];
      return typeof spec?.$slice === "number" && spec.$slice < 0
        ? next.slice(spec.$slice)
        : next;
    });
  }
  for (const [field, criteria] of Object.entries(asRow(update.$pull ?? {}))) {
    setPath(row, field, (current) =>
      ((current as Row[]) ?? []).filter(
        (item) => !matches(asRow(item), criteria as Row),
      ),
    );
  }
  for (const [field, next] of Object.entries(asRow(update.$set ?? {}))) {
    setPath(row, field, () => next);
  }
  for (const [field] of Object.entries(asRow(update.$unset ?? {}))) {
    // Delete rather than set to undefined, so `$exists` and key enumeration
    // behave as they do in MongoDB.
    const segments = field.split(".");
    let target: Row | undefined = row;
    for (const segment of segments.slice(0, -1)) {
      target = target ? asRow(target[segment]) : undefined;
    }
    if (target) delete target[segments[segments.length - 1] as string];
  }
}

export function mongoStore() {
  const rows: Row[] = [];
  return {
    rows,
    async deleteOne(filter: Row) {
      const index = rows.findIndex((row) => matches(row, filter));
      if (index < 0) return { deletedCount: 0 };
      rows.splice(index, 1);
      return { deletedCount: 1 };
    },
    async insertOne(row: Row) {
      rows.push(structuredClone(row));
      return { insertedId: row.id };
    },
    async findOne(filter: Row) {
      return structuredClone(rows.find((row) => matches(row, filter)) ?? null);
    },
    async findOneAndUpdate(filter: Row, update: Row) {
      const row = rows.find((item) => matches(item, filter));
      if (!row) return null;
      apply(row, update);
      return structuredClone(row);
    },
    async updateOne(filter: Row, update: Row, options?: { upsert?: boolean }) {
      const row = rows.find((item) => matches(item, filter));
      if (row) {
        apply(row, update);
        return { matchedCount: 1, modifiedCount: 1 };
      }
      if (!options?.upsert) return { matchedCount: 0, modifiedCount: 0 };
      const created: Row = { ...filter, ...asRow(update.$setOnInsert ?? {}) };
      apply(created, { ...update, $setOnInsert: undefined });
      rows.push(created);
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
    },
    async updateMany(filter: Row, update: Row) {
      const matched = rows.filter((row) => matches(row, filter));
      for (const row of matched) apply(row, update);
      return { matchedCount: matched.length, modifiedCount: matched.length };
    },
    async countDocuments(filter: Row) {
      return rows.filter((row) => matches(row, filter)).length;
    },
    find(filter: Row) {
      const cursor = {
        sort: () => cursor,
        limit: () => cursor,
        project: () => cursor,
        async toArray() {
          return structuredClone(rows.filter((row) => matches(row, filter)));
        },
      };
      return cursor;
    },
  };
}
