import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PaginationHelper, paginateAll, collectAllPages } from '../src/pagination';
import type { PaginatedResponse, PageFetcher } from '../src/types';

const mockPage1: PaginatedResponse<{ id: string }> = {
  data: [{ id: 'a' }, { id: 'b' }],
  nextCursor: 'cursor-2',
  hasMore: true,
};

const mockPage2: PaginatedResponse<{ id: string }> = {
  data: [{ id: 'c' }, { id: 'd' }],
  nextCursor: null,
  hasMore: false,
};

describe('PaginationHelper', () => {
  let fetcher: PageFetcher<{ id: string }>;

  beforeEach(() => {
    fetcher = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getPage returns a single page', async () => {
    fetcher.mockResolvedValueOnce(mockPage1);
    const helper = new PaginationHelper(fetcher);
    const result = await helper.getPage({ limit: 2 });
    expect(result).toEqual(mockPage1);
    expect(fetcher).toHaveBeenCalledWith({});
  });

  it('getPage passes params through', async () => {
    fetcher.mockResolvedValueOnce(mockPage1);
    const helper = new PaginationHelper(fetcher);
    await helper.getPage({ cursor: 'cursor-1', limit: 5 });
    expect(fetcher).toHaveBeenCalledWith({ cursor: 'cursor-1', limit: 5 });
  });

  it('pages yields all pages until hasMore is false', async () => {
    fetcher.mockResolvedValueOnce(mockPage1).mockResolvedValueOnce(mockPage2);
    const helper = new PaginationHelper(fetcher);

    const pages: PaginatedResponse<{ id: string }>[] = [];
    for await (const page of helper.pages()) {
      pages.push(page);
    }

    expect(pages).toHaveLength(2);
    expect(pages[0]).toEqual(mockPage1);
    expect(pages[1]).toEqual(mockPage2);
  });

  it('pages stops when abort signal is triggered', async () => {
    fetcher.mockResolvedValueOnce(mockPage1).mockResolvedValueOnce(mockPage2);
    const helper = new PaginationHelper(fetcher);

    const controller = new AbortController();
    const pages: PaginatedResponse<{ id: string }>[] = [];

    const generator = helper.pages(controller.signal);
    const first = await generator.next();
    expect(first.value).toEqual(mockPage1);

    controller.abort();
    for await (const page of generator) {
      pages.push(page);
    }

    expect(pages).toHaveLength(0);
  });

  it('all collects all items from all pages', async () => {
    fetcher.mockResolvedValueOnce(mockPage1).mockResolvedValueOnce(mockPage2);
    const helper = new PaginationHelper(fetcher);
    const result = await helper.all();
    expect(result).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]);
  });

  it('fetchParallel fetches cursors in batches', async () => {
    const batch1 = { data: [{ id: 'a' }], nextCursor: null, hasMore: false };
    const batch2 = { data: [{ id: 'b' }], nextCursor: null, hasMore: false };
    fetcher.mockResolvedValueOnce(batch1).mockResolvedValueOnce(batch2);

    const helper = new PaginationHelper(fetcher, { concurrency: 2 });
    const result = await helper.fetchParallel(['cursor-1', 'cursor-2']);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(batch1);
    expect(result[1]).toEqual(batch2);
  });
});

describe('paginateAll', () => {
  it('yields pages from the fetcher', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(mockPage1).mockResolvedValueOnce(mockPage2);
    const pages: PaginatedResponse<{ id: string }>[] = [];

    for await (const page of paginateAll(fetcher)) {
      pages.push(page);
    }

    expect(pages).toHaveLength(2);
  });

  it('supports abort signal', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(mockPage1);
    const controller = new AbortController();

    const gen = paginateAll(fetcher, { signal: controller.signal });
    const first = await gen.next();
    expect(first.value).toEqual(mockPage1);

    controller.abort();
    for await (const _ of gen) {
      // should not yield more
    }
  });
});

describe('collectAllPages', () => {
  it('collects all items into a flat array', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(mockPage1).mockResolvedValueOnce(mockPage2);
    const result = await collectAllPages(fetcher);
    expect(result).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]);
  });

  it('supports abort signal', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(mockPage1);
    const controller = new AbortController();

    const promise = collectAllPages(fetcher, { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toThrow();
  });
});
