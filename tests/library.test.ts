import { describe, expect, test } from 'vitest';
import {
  buildLibraryEntries,
  enumerateDirectory,
  isSpcFile,
  listLibraryDirectory,
  stripLibraryRoot,
} from '../src/library/library';

describe('SPC library', () => {
  test('accepts SPC extensions case-insensitively', () => {
    expect(isSpcFile('track.spc')).toBe(true);
    expect(isSpcFile('TRACK.SPC')).toBe(true);
    expect(isSpcFile('track.spc.txt')).toBe(false);
  });

  test('keeps nested paths and naturally sorts with stable path identities', () => {
    const entries = buildLibraryEntries('session-7', [
      { name: 'Track 10.SPC', relativePath: 'Game B/Track 10.SPC' },
      { name: 'readme.txt', relativePath: 'Game A/readme.txt' },
      { name: 'Track 2.spc', relativePath: 'Game B/Track 2.spc' },
      { name: 'Root.spc', relativePath: 'Root.spc' },
      { name: 'same.spc', relativePath: 'Game A/same.spc' },
    ]);

    expect(entries.map((entry) => entry.relativePath)).toEqual([
      'Game A/same.spc',
      'Game B/Track 2.spc',
      'Game B/Track 10.SPC',
      'Root.spc',
    ]);
    expect(entries[0].id).toBe('session-7:Game A/same.spc');
    expect(entries[3].folder).toBe('Library root');
  });

  test('directory enumeration keeps file handles lazy', async () => {
    let opened = 0;
    const file = new File([new Uint8Array(0x10180)], 'track.spc');
    const handle = {
      kind: 'file' as const,
      name: file.name,
      async getFile() { opened += 1; return file; },
    };
    const root = {
      kind: 'directory' as const,
      name: 'Music',
      async *entries() { yield [handle.name, handle] as [string, typeof handle]; },
    };

    const descriptors = await enumerateDirectory(root);
    expect(opened).toBe(0);
    expect(descriptors).toHaveLength(1);
    await descriptors[0].open!();
    expect(opened).toBe(1);
  });

  test('keeps every entry in a ten-thousand-track nested library reachable', () => {
    const descriptors = Array.from({ length: 10_000 }, (_, index) => ({
      name: 'track-' + index + '.spc',
      relativePath: 'disc-' + Math.floor(index / 100) + '/track-' + index + '.spc',
    }));
    const entries = buildLibraryEntries('large', descriptors);
    expect(entries).toHaveLength(10_000);
    expect(entries.some((entry) => entry.relativePath.endsWith('/track-9999.spc'))).toBe(true);
  });

  test('lists only immediate tracks and child folders at each directory level', () => {
    const entries = buildLibraryEntries('nested', [
      { name: 'Root.spc', relativePath: 'Root.spc' },
      { name: 'One.spc', relativePath: 'Games/Mario/One.spc' },
      { name: 'Two.spc', relativePath: 'Games/Mario/Two.spc' },
      { name: 'Theme.spc', relativePath: 'Games/Zelda/Theme.spc' },
      { name: 'Loose.spc', relativePath: 'Misc/Loose.spc' },
    ]);
    expect(listLibraryDirectory(entries, '', '')).toEqual({
      folders: [
        { name: 'Games', path: 'Games', trackCount: 3 },
        { name: 'Misc', path: 'Misc', trackCount: 1 },
      ],
      tracks: [entries.find((entry) => entry.relativePath === 'Root.spc')],
    });
    expect(listLibraryDirectory(entries, 'Games', '')).toEqual({
      folders: [
        { name: 'Mario', path: 'Games/Mario', trackCount: 2 },
        { name: 'Zelda', path: 'Games/Zelda', trackCount: 1 },
      ],
      tracks: [],
    });
  });

  test('searches track paths across the whole library from inside a folder', () => {
    const entries = buildLibraryEntries('search', [
      { name: 'Boss Theme.spc', relativePath: 'Game A/Boss Theme.spc' },
      { name: 'Town.spc', relativePath: 'Game A/Town.spc' },
      { name: 'Final Boss.spc', relativePath: 'Game B/Final Boss.spc' },
    ]);
    expect(listLibraryDirectory(entries, 'Game A', 'boss')).toEqual({
      folders: [],
      tracks: [entries[0], entries[2]],
    });
  });

  test('removes the picker root from webkit directory paths', () => {
    const descriptors = [
      { name: 'One.spc', relativePath: 'SPC Collection/Game A/One.spc' },
      { name: 'Loose.spc', relativePath: 'SPC Collection/Loose.spc' },
    ];
    expect(stripLibraryRoot(descriptors, 'SPC Collection')).toEqual([
      { name: 'One.spc', relativePath: 'Game A/One.spc' },
      { name: 'Loose.spc', relativePath: 'Loose.spc' },
    ]);
  });
});
