export type LibraryFileDescriptor = {
  name: string;
  relativePath: string;
  file?: File;
  open?: () => Promise<File>;
};

export type LibraryEntry = LibraryFileDescriptor & {
  id: string;
  folder: string;
};

export type LibraryFolder = {
  name: string;
  path: string;
  trackCount: number;
};

export type LibraryDirectoryListing = {
  folders: LibraryFolder[];
  tracks: LibraryEntry[];
};

const pathCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

export const isSpcFile = (name: string) => /\.spc$/i.test(name);

export const buildLibraryEntries = (
  sessionId: string,
  files: LibraryFileDescriptor[],
): LibraryEntry[] =>
  files
    .filter((file) => isSpcFile(file.name))
    .map((file) => {
      const normalized = file.relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
      const separator = normalized.lastIndexOf('/');
      return {
        ...file,
        relativePath: normalized,
        id: sessionId + ':' + normalized,
        folder: separator < 0 ? 'Library root' : normalized.slice(0, separator),
      };
    })
    .sort((left, right) => {
      const compared = pathCollator.compare(left.relativePath, right.relativePath);
      return compared || left.relativePath.localeCompare(right.relativePath);
    });

export const listLibraryDirectory = (
  entries: LibraryEntry[],
  directory: string,
  query: string,
): LibraryDirectoryListing => {
  const needle = query.trim().toLocaleLowerCase();
  if (needle) {
    return {
      folders: [],
      tracks: entries.filter((entry) => entry.relativePath.toLocaleLowerCase().includes(needle)),
    };
  }

  const normalizedDirectory = directory.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const prefix = normalizedDirectory ? normalizedDirectory + '/' : '';
  const folders = new Map<string, LibraryFolder>();
  const tracks: LibraryEntry[] = [];

  for (const entry of entries) {
    if (prefix && !entry.relativePath.startsWith(prefix)) continue;
    const remainder = prefix ? entry.relativePath.slice(prefix.length) : entry.relativePath;
    const separator = remainder.indexOf('/');
    if (separator < 0) {
      tracks.push(entry);
      continue;
    }
    const name = remainder.slice(0, separator);
    const path = prefix + name;
    const existing = folders.get(path);
    if (existing) existing.trackCount += 1;
    else folders.set(path, { name, path, trackCount: 1 });
  }

  return {
    folders: Array.from(folders.values()).sort((left, right) => {
      const compared = pathCollator.compare(left.name, right.name);
      return compared || left.name.localeCompare(right.name);
    }),
    tracks,
  };
};

export const filesFromInput = (list: FileList): LibraryFileDescriptor[] =>
  Array.from(list).map((file) => ({
    file,
    open: async () => file,
    name: file.name,
    relativePath: file.webkitRelativePath || file.name,
  }));

export const stripLibraryRoot = (
  files: LibraryFileDescriptor[],
  rootName: string,
): LibraryFileDescriptor[] => {
  const normalizedRoot = rootName.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const prefix = normalizedRoot + '/';
  if (!normalizedRoot || !files.length || !files.every((file) => file.relativePath.replace(/\\/g, '/').startsWith(prefix))) {
    return files;
  }
  return files.map((file) => ({
    ...file,
    relativePath: file.relativePath.replace(/\\/g, '/').slice(prefix.length),
  }));
};

type FileSystemFileHandleLike = {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
};

export type FileSystemDirectoryHandleLike = {
  kind: 'directory';
  name: string;
  entries(): AsyncIterableIterator<[string, FileSystemFileHandleLike | FileSystemDirectoryHandleLike]>;
  queryPermission?(options: { mode: 'read' }): Promise<'granted' | 'denied' | 'prompt'>;
  requestPermission?(options: { mode: 'read' }): Promise<'granted' | 'denied' | 'prompt'>;
};

export const enumerateDirectory = async (
  root: FileSystemDirectoryHandleLike,
  options: { signal?: AbortSignal; onProgress?: (entries: number) => void } = {},
): Promise<LibraryFileDescriptor[]> => {
  const found: LibraryFileDescriptor[] = [];
  const visit = async (directory: FileSystemDirectoryHandleLike, prefix: string) => {
    for await (const [, handle] of directory.entries()) {
      if (options.signal?.aborted) throw new DOMException('Folder scan canceled', 'AbortError');
      const relativePath = prefix ? prefix + '/' + handle.name : handle.name;
      if (handle.kind === 'directory') {
        await visit(handle, relativePath);
      } else if (isSpcFile(handle.name)) {
        found.push({ open: () => handle.getFile(), name: handle.name, relativePath });
        options.onProgress?.(found.length);
      }
    }
  };
  await visit(root, '');
  return found;
};
