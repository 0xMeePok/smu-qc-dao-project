export function memoryDb(initial = {}) {
  const records = new Map(Object.entries(initial));
  let reads = 0;
  let queue = Promise.resolve();
  const snapshot = (path) => {
    const value = records.get(path);
    return { id: path.split("/").at(-1), ref: reference(path), exists: records.has(path), data: () => value };
  };
  const reference = (path) => ({ path, id: path.split("/").at(-1),
    get: async () => { reads++; return snapshot(path); },
    set: async (data) => records.set(path, data),
    delete: async () => records.delete(path),
  });
  const comparable = (value) => value?.toMillis?.() ?? value;
  const collection = (name, filters = [], cap = Infinity, orders = [], cursor = []) => {
    const named = (field) => (typeof field === "string" ? field : "__name__");
    const fieldValue = (path, rawField) => named(rawField) === "__name__" ? path.split("/").at(-1) : comparable(named(rawField).split(".").reduce((value, key) => value?.[key], records.get(path)));
    return {
      doc: (id) => reference(`${name}/${id}`),
      where: (field, op, value) => collection(name, [...filters, [field, op, value]], cap, orders, cursor),
      limit: (n) => collection(name, filters, n, orders, cursor),
      orderBy: (field, direction = "asc") => collection(name, filters, cap, [...orders, { field, direction }], cursor),
      startAfter: (...values) => collection(name, filters, cap, orders, values.map(comparable)),
      get: async () => {
        const depth = name.split("/").length + 1;
        const paths = [...records.keys()].filter((path) => path.startsWith(`${name}/`) && path.split("/").length === depth
          && filters.every(([field, op, value]) => op === "==" ? fieldValue(path, field) === comparable(value)
            : op === "in" ? value.includes(fieldValue(path, field)) : op === "<=" ? fieldValue(path, field) != null && fieldValue(path, field) <= comparable(value) : fieldValue(path, field) < comparable(value)))
          .sort((a, b) => { for (const { field, direction } of orders) { const x = fieldValue(a, field), y = fieldValue(b, field); if (x !== y) return (x < y ? -1 : 1) * (direction === "desc" ? -1 : 1); } return 0; })
          .filter((path) => { if (!cursor.length) return true; for (let i = 0; i < orders.length; i++) { const value = fieldValue(path, orders[i].field); if (value !== cursor[i]) return orders[i].direction === "desc" ? value < cursor[i] : value > cursor[i]; } return false; }).slice(0, cap);
        return { docs: paths.map(snapshot), size: paths.length, empty: !paths.length };
      },
    };
  };
  return { records, get reads() { return reads; }, collection,
    getAll: async (...refs) => Promise.all(refs.map((ref) => ref.get())),
    runTransaction(fn) {
      const task = queue.then(() => {
        const writes = [];
        return Promise.resolve(fn({ get: (ref) => ref.get(),
          create: (ref, data) => { if (records.has(ref.path)) throw new Error("Document already exists"); writes.push(() => records.set(ref.path, data)); },
          set: (ref, data) => writes.push(() => records.set(ref.path, data)),
          update: (ref, data) => writes.push(() => records.set(ref.path, { ...records.get(ref.path), ...data })),
          delete: (ref) => writes.push(() => records.delete(ref.path)),
        })).then((result) => { writes.forEach((write) => write()); return result; });
      });
      queue = task.catch(() => {});
      return task;
    },
  };
}
