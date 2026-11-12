export type LibraryLayout = { open: boolean; pinned: boolean };

export const loadLibraryLayout = (): LibraryLayout => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem('spc-library-layout') ?? 'null');
    if (value && typeof value === 'object') {
      const saved = value as Partial<LibraryLayout>;
      return { open: saved.open !== false, pinned: saved.pinned === true };
    }
  } catch { /* Layout falls back to a usable floating library when storage is unavailable. */ }
  return { open: true, pinned: false };
};

export const saveLibraryLayout = (layout: LibraryLayout) => {
  try { localStorage.setItem('spc-library-layout', JSON.stringify(layout)); } catch { /* Playback remains available without storage. */ }
};
