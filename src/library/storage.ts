import type { FileSystemDirectoryHandleLike, LibraryFileDescriptor } from './library';

// Keep the persistent identifier stable so saved libraries remain available.
const DATABASE_NAME = 'spc-memory-scope';
const STORE_NAME = 'saved-state';
const LIBRARY_KEY = 'library';

type SavedFile = {
  name: string;
  relativePath: string;
  file: File;
};

export type SavedLibrary =
  | { kind: 'directory'; name: string; handle: FileSystemDirectoryHandleLike }
  | { kind: 'files'; name: string; files: SavedFile[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isSafeRelativePath = (value: unknown): value is string => {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.startsWith('\\')) return false;
  const segments = value.replace(/\\/g, '/').split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
};

const isSavedFile = (value: unknown): value is SavedFile =>
  isRecord(value)
  && typeof value.name === 'string'
  && value.name.length > 0
  && isSafeRelativePath(value.relativePath)
  && typeof File !== 'undefined'
  && value.file instanceof File;

const isDirectoryHandle = (value: unknown): value is FileSystemDirectoryHandleLike =>
  isRecord(value)
  && value.kind === 'directory'
  && typeof value.name === 'string'
  && value.name.length > 0
  && typeof value.entries === 'function';

const validateSavedLibrary = (value: unknown): SavedLibrary | null => {
  if (!isRecord(value) || typeof value.name !== 'string' || !value.name) return null;
  if (value.kind === 'directory' && isDirectoryHandle(value.handle)) {
    return { kind: 'directory', name: value.name, handle: value.handle };
  }
  if (value.kind === 'files' && Array.isArray(value.files) && value.files.every(isSavedFile)) {
    return { kind: 'files', name: value.name, files: value.files };
  }
  return null;
};

const openDatabase = () => new Promise<IDBDatabase>((resolve, reject) => {
  if (typeof indexedDB === 'undefined') {
    reject(new Error('This browser does not provide persistent library storage.'));
    return;
  }
  const request = indexedDB.open(DATABASE_NAME, 1);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('Unable to open browser storage.'));
});

const transactionComplete = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onabort = () => reject(transaction.error ?? new Error('The browser canceled the save.'));
  transaction.onerror = () => reject(transaction.error ?? new Error('Unable to save the library.'));
});

export const saveDirectoryLibrary = async (name: string, handle: FileSystemDirectoryHandleLike) => {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put({ kind: 'directory', name, handle } satisfies SavedLibrary, LIBRARY_KEY);
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
};

export const saveFileLibrary = async (name: string, descriptors: LibraryFileDescriptor[]) => {
  const files = descriptors.map((descriptor) => {
    if (!descriptor.file) throw new Error('This browser cannot save this file selection. Open the original folder again next time.');
    return { name: descriptor.name, relativePath: descriptor.relativePath, file: descriptor.file };
  });
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put({ kind: 'files', name, files } satisfies SavedLibrary, LIBRARY_KEY);
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
};

export const loadSavedLibrary = async (): Promise<SavedLibrary | null> => {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const complete = transactionComplete(transaction);
    const request = transaction.objectStore(STORE_NAME).get(LIBRARY_KEY);
    const saved = await new Promise<unknown>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Unable to read the saved library.'));
    });
    await complete;
    return validateSavedLibrary(saved);
  } finally {
    database.close();
  }
};

export const descriptorsFromSavedFiles = (saved: Extract<SavedLibrary, { kind: 'files' }>): LibraryFileDescriptor[] =>
  saved.files.map(({ file, name, relativePath }) => ({
    file,
    name,
    relativePath,
    open: async () => file,
  }));
