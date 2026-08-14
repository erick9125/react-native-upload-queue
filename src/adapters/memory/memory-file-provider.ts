import type { FileProvider } from '../../core/contracts/file-provider.js';

export function createMemoryFileProvider(
  files: Record<string, { size?: number; missing?: boolean }> = {},
): FileProvider & {
  setFile(uri: string, file: { size?: number; missing?: boolean }): void;
  remove(uri: string): void;
} {
  const store = new Map(Object.entries(files));

  return {
    async exists(uri: string): Promise<boolean> {
      const file = store.get(uri);
      if (!file) {
        return true;
      }
      return file.missing !== true;
    },
    async getSize(uri: string): Promise<number | undefined> {
      return store.get(uri)?.size;
    },
    setFile(uri: string, file: { size?: number; missing?: boolean }): void {
      store.set(uri, file);
    },
    remove(uri: string): void {
      store.set(uri, { missing: true });
    },
  };
}
