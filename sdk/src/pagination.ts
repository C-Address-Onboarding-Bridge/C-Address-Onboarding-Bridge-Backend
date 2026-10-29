import { PaginatedResponse, PaginatedRequestParams, AutoPaginateOptions, PageFetcher } from './types.js';

export class PaginationHelper<T> {
  constructor(
    private readonly fetcher: PageFetcher<T>,
    private readonly options: AutoPaginateOptions = {},
  ) {}

  async getPage(params?: PaginatedRequestParams): Promise<PaginatedResponse<T>> {
    return this.fetcher(params ?? {});
  }

  async *pages(signal?: AbortSignal): AsyncGenerator<PaginatedResponse<T>> {
    const sig = signal ?? this.options.signal;
    const throttleMs = this.options.throttleMs ?? 0;
    let cursor: string | undefined;
    const seenCursors = new Set<string>();

    const abortError = (): Error => {
      const reason = sig?.reason;
      if (reason instanceof Error) return reason;
      const err = new Error('Aborted');
      err.name = 'AbortError';
      return err;
    };

    do {
      // Graceful stop between pages when aborted.
      if (sig?.aborted) break;

      let page: PaginatedResponse<T>;
      const fetchPromise = this.fetcher({ cursor, limit: this.options.pageSize });
      if (!sig) {
        page = await fetchPromise;
      } else {
        page = await new Promise<PaginatedResponse<T>>((resolve, reject) => {
          if (sig.aborted) {
            reject(abortError());
            return;
          }
          const onAbort = () => reject(abortError());
          sig.addEventListener('abort', onAbort, { once: true });
          fetchPromise.then(
            (p) => { sig.removeEventListener('abort', onAbort); resolve(p); },
            (e) => { sig.removeEventListener('abort', onAbort); reject(e); },
          );
        });
      }

      // If aborted during/after fetch, propagate.
      if (sig?.aborted) throw abortError();

      yield page;

      const nextCursor = page.nextCursor ?? undefined;
      if (!page.hasMore || !nextCursor || seenCursors.has(nextCursor)) {
        cursor = undefined;
        break;
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;

      if (cursor && throttleMs > 0) {
        await this.delayWithSignal(throttleMs, sig);
      }
    } while (cursor);
  }

  async all(signal?: AbortSignal): Promise<T[]> {
    const results: T[] = [];
    for await (const page of this.pages(signal)) {
      results.push(...page.data);
    }
    return results;
  }

  async fetchParallel(cursors: string[]): Promise<PaginatedResponse<T>[]> {
    const concurrency = this.options.concurrency ?? 3;
    const results: PaginatedResponse<T>[] = [];

    for (let i = 0; i < cursors.length; i += concurrency) {
      const batch = cursors.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map((cursor) => this.fetcher({ cursor, limit: this.options.pageSize })),
      );
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * Wait `ms` milliseconds, or reject early if `signal` is (or becomes) aborted.
   *
   * The abort listener is removed in both the resolve and reject paths so that
   * repeated throttled iterations do not accumulate listeners on a shared
   * `AbortSignal`. Using `{ once: true }` is insufficient because the listener
   * is only auto-removed when it actually fires.
   */
  private delayWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(new Error('Aborted'));
    }

    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const err = new Error('Aborted');
        err.name = 'AbortError';
        reject(err);
      };

      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);

      signal?.addEventListener('abort', onAbort);
    });
  }
}

export async function* paginateAll<T>(
  fetcher: PageFetcher<T>,
  options?: AutoPaginateOptions,
): AsyncGenerator<PaginatedResponse<T>> {
  const helper = new PaginationHelper(fetcher, options);
  yield* helper.pages(options?.signal);
}

export async function collectAllPages<T>(
  fetcher: PageFetcher<T>,
  options?: AutoPaginateOptions,
): Promise<T[]> {
  const helper = new PaginationHelper(fetcher, options);
  return helper.all(options?.signal);
}
