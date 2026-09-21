/** Atomic in-memory document operations for controlled asynchronous races. */
type Row = Record<string, unknown>;

function matches(row: Row, filter: Row): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or")
      return (expected as Row[]).some((item) => matches(row, item));
    const actual = row[key];
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      return Object.entries(expected).every(([op, value]) => {
        if (op === "$exists") return (actual !== undefined) === value;
        if (op === "$in") return (value as unknown[]).includes(actual);
        if (op === "$nin") return !(value as unknown[]).includes(actual);
        if (op === "$ne") return actual !== value;
        // Date comparison, as the stale-claim filter needs. An absent field
        // never compares, exactly as in MongoDB.
        if (op === "$lte") {
          return (
            actual instanceof Date &&
            actual.getTime() <= (value as Date).getTime()
          );
        }
        if (op === "$gte") {
          return (
            actual instanceof Date &&
            actual.getTime() >= (value as Date).getTime()
          );
        }
        throw new Error(`Unsupported test operator ${op}`);
      });
    }
    return actual === expected;
  });
}

export function documentStore() {
  const rows: Row[] = [];
  function change(filter: Row, update: { $set?: Row; $unset?: Row }) {
    const row = rows.find((item) => matches(item, filter));
    if (!row) return null;
    Object.assign(row, structuredClone(update.$set ?? {}));
    for (const key of Object.keys(update.$unset ?? {})) delete row[key];
    return structuredClone(row);
  }
  return {
    rows,
    async insertOne(row: Row) {
      rows.push(structuredClone(row));
      return { insertedId: row.id };
    },
    async findOne(filter: Row) {
      return structuredClone(rows.find((row) => matches(row, filter)) ?? null);
    },
    async updateOne(filter: Row, update: { $set?: Row; $unset?: Row }) {
      const row = change(filter, update);
      return { matchedCount: row ? 1 : 0, modifiedCount: row ? 1 : 0 };
    },
    async findOneAndUpdate(filter: Row, update: { $set?: Row; $unset?: Row }) {
      return change(filter, update);
    },
    find(filter: Row) {
      const cursor = {
        sort() {
          return cursor;
        },
        limit() {
          return cursor;
        },
        project() {
          return cursor;
        },
        async toArray() {
          return structuredClone(rows.filter((row) => matches(row, filter)));
        },
      };
      return cursor;
    },
  };
}
