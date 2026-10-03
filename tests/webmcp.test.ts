import { describe, expect, it, vi } from 'vitest';
import { registerSpcWebTools, type RegisteredWebTool } from '../src/webmcp';

describe('WebMCP surface', () => {
  it('applies representation options after selecting the measurement and rejects invalid types before mutation', async () => {
    const tools: RegisteredWebTool[] = [], calls: unknown[] = [];
    registerSpcWebTools({ context: { registerTool: tool => { tools.push(tool); } }, getState: () => ({ loaded: true, playing: false, trackTitle: null, aramMode: 'data' }),
      setAramMode: mode => { calls.push(mode); }, setAramOptions: options => { calls.push(options); } });
    expect(await tools[1].execute({ mode: 'data', activityUnit: 'bit', dataUnit: 'bit', dataXor: true, entropyUnit: 'bit' })).toEqual({ mode: 'data', activityUnit: 'bit', dataUnit: 'bit', dataXor: true, entropyUnit: 'bit' });
    expect(calls).toEqual(['data', { activityUnit: 'bit', dataUnit: 'bit', dataXor: true, entropyUnit: 'bit' }]);
    for (const invalid of [{ activityUnit: 'bits' }, { dataUnit: 'bits' }, { dataXor: 'on' }, { entropyUnit: 'bytes' }]) expect(() => tools[1].execute({ mode: 'data', ...invalid })).toThrow('Invalid ARAM view');
    expect(calls).toHaveLength(2);
  });
  it.each(['xor', 'entropy'])('accepts the new %s measurement with the existing request shape', async mode => {
    const tools: RegisteredWebTool[] = []; const setAramMode = vi.fn();
    registerSpcWebTools({ context: { registerTool: tool => { tools.push(tool); } }, getState: () => ({ loaded: true, playing: true, trackTitle: null, aramMode: 'activity' }), setAramMode });
    expect(await tools[1].execute({ mode })).toEqual({ mode }); expect(setAramMode).toHaveBeenCalledWith(mode);
  });
  it('registers read and visualizer tools against visible app state', async () => {
    const tools: RegisteredWebTool[] = [];
    const setAramMode = vi.fn(async () => undefined);
    const controller = registerSpcWebTools({
      context: { registerTool: (tool) => { tools.push(tool); } },
      getState: () => ({ loaded: true, playing: true, trackTitle: 'Test track', aramMode: 'activity' }),
      setAramMode,
    });

    expect(tools.map((tool) => tool.name)).toEqual(['read_spc_player_state', 'set_aram_view']);
    expect(await tools[0].execute({})).toEqual({
      loaded: true, playing: true, trackTitle: 'Test track', aramMode: 'activity',
    });
    expect(tools[0].annotations.untrustedContentHint).toBe(true);
    expect(await tools[1].execute({ mode: 'bits' })).toEqual({ mode: 'bits' });
    expect(setAramMode).toHaveBeenCalledWith('bits');

    controller.abort();
    expect(controller.signal.aborted).toBe(true);
  });

  it('rejects invalid visualizer modes without changing state', async () => {
    const tools: RegisteredWebTool[] = [];
    const setAramMode = vi.fn();
    registerSpcWebTools({
      context: { registerTool: (tool) => { tools.push(tool); } },
      getState: () => ({ loaded: false, playing: false, trackTitle: null, aramMode: 'data' }),
      setAramMode,
    });

    expect(() => tools[1].execute({ mode: 'pixels' })).toThrow('Invalid ARAM view');
    expect(() => tools[1].execute({ mode: 'bits', extra: true })).toThrow('Invalid ARAM view');
    expect(setAramMode).not.toHaveBeenCalled();
  });
});
