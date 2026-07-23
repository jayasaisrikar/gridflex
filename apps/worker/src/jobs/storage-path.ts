import { isAbsolute, relative, resolve } from 'node:path';

/** Resolve only files inside STORAGE_ROOT; reject remote and traversal URIs. */
export function safeStoragePath(storageRoot: string, storageUri: string): string | null {
  if (storageUri.includes('://') || storageUri.includes('\0')) return null;

  const root = resolve(storageRoot);
  const candidate = resolve(root, isAbsolute(storageUri) ? relative(root, storageUri) : storageUri);
  const rel = relative(root, candidate);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return candidate;
}
