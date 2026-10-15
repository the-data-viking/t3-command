/** Small in-memory read cache. Mutations invalidate pending results as well as stored values. */
export class ReadCache {
  private values = new Map<string, { value: unknown; expires: number }>();
  private pending = new Map<string, Promise<unknown>>();
  private generation = 0;

  peek<T>(key: string): T | undefined {
    const entry = this.values.get(key);
    // Stale data is useful while a mounted panel revalidates, but not indefinitely.
    return entry && Date.now() < entry.expires + 60_000 ? entry.value as T : undefined;
  }

  clear(): void {
    this.generation++;
    this.values.clear();
    this.pending.clear();
  }

  async read<T>(key: string, load: () => Promise<T>, ttl: number, fresh = false): Promise<T> {
    const active = this.pending.get(key);
    if (active) return active as Promise<T>;
    const cached = this.values.get(key);
    if (!fresh && cached && Date.now() < cached.expires) return Promise.resolve(cached.value as T);
    const generation = this.generation;
    const operation = load().then(value => {
      if (generation === this.generation && ttl > 0) {
        this.values.delete(key);
        this.values.set(key, { value, expires: Date.now() + ttl });
        if (this.values.size > 100) this.values.delete(this.values.keys().next().value!);
      }
      return value;
    });
    this.pending.set(key, operation);
    const done = () => { if (this.pending.get(key) === operation) this.pending.delete(key); };
    void operation.then(done, done);
    return operation;
  }
}
