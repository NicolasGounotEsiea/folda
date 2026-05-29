/// In-memory LRU + TTL cache for folder size computations.
///
/// Why this exists:
/// `get_folder_stats` and `get_folder_sizes` walk the entire directory tree on
/// every call. Re-opening the preview panel for a folder you just left, or
/// navigating back-and-forth in the explorer, re-runs the same expensive walk.
/// A small in-memory cache makes those scenarios feel instant.
///
/// Design choices:
/// - TTL = 30 seconds. Folder contents can change at any moment via the watcher.
///   30s is long enough to make back/forth navigation cheap but short enough that
///   the user rarely sees stale numbers.
/// - LRU size = 32 entries. Folder stats objects are tiny (a breakdown array of
///   ~20 entries). 32 × ~2 KB = ~64 KB max overhead.
/// - Cache key is the absolute path. Calls with the same path share a result.

import type { FolderStats } from "../types";

type FolderSizeEntry = {
  name: string;
  path: string;
  size: number;
  is_dir: boolean;
};

interface CacheEntry<T> {
  value: T;
  storedAt: number;
}

const TTL_MS = 30_000;
const MAX_ENTRIES = 32;

const statsCache = new Map<string, CacheEntry<FolderStats>>();
const sizesCache = new Map<string, CacheEntry<FolderSizeEntry[]>>();

function getFromCache<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.storedAt > TTL_MS) {
    cache.delete(key);
    return null;
  }
  // LRU: touch by re-inserting at the end of the Map's insertion order
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function putInCache<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T) {
  cache.set(key, { value, storedAt: Date.now() });
  // Evict oldest entries beyond the cap
  while (cache.size > MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

export function getCachedFolderStats(path: string): FolderStats | null {
  return getFromCache(statsCache, path);
}

export function cacheFolderStats(path: string, value: FolderStats) {
  putInCache(statsCache, path, value);
}

export function getCachedFolderSizes(path: string): FolderSizeEntry[] | null {
  return getFromCache(sizesCache, path);
}

export function cacheFolderSizes(path: string, value: FolderSizeEntry[]) {
  putInCache(sizesCache, path, value);
}

/// Invalidate cache entries when something changed on disk. Called by the file
/// watcher's frontend listener to keep results fresh after mutations.
export function invalidateFolderCacheForPath(path: string) {
  const norm = path.replace(/\\/g, "/").toLowerCase();
  for (const key of [...statsCache.keys()]) {
    if (key.replace(/\\/g, "/").toLowerCase().startsWith(norm)) statsCache.delete(key);
  }
  for (const key of [...sizesCache.keys()]) {
    if (key.replace(/\\/g, "/").toLowerCase().startsWith(norm)) sizesCache.delete(key);
  }
}

export function clearFolderCache() {
  statsCache.clear();
  sizesCache.clear();
}
