import { PaginatedResponse, PaginatedRequestParams, AutoPaginateOptions, PageFetcher } from './types';

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

    do {
      if (sig?.aborted) break;

      const page = await this.fetcher({ cursor, limit: this.options.pageSize });
      yield page;

      cursor = page.nextCursor ?? undefined;

      if (cursor && throttleMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, throttleMs);
          sig?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new Error('Aborted'));
          }, { once: true });
        });
      }
    } while (cursor && !sig?.aborted);
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
