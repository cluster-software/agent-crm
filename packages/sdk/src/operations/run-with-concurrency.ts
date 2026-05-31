export async function runWithConcurrency(
  total: number,
  concurrency: number,
  worker: (index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  let firstError: unknown = null;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), Math.max(1, total)) },
    async () => {
      while (next < total && !firstError) {
        const index = next++;
        try {
          await worker(index);
        } catch (error) {
          firstError ??= error;
          return;
        }
      }
    },
  );
  await Promise.all(workers);
  if (firstError) throw firstError;
}
