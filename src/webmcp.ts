import { ARAM_MEASUREMENTS, type AramMeasurement, type DataUnit } from './aram/types';
type ToolMode = AramMeasurement | 'bytes' | 'bits' | 'xor';
type DataOptions = { activityUnit?: DataUnit; dataUnit?: DataUnit; dataXor?: boolean; entropyUnit?: DataUnit };
const toolModes = [...ARAM_MEASUREMENTS, 'bytes', 'bits', 'xor'] as const;

export type RegisteredWebTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
  execute(input: unknown): unknown | Promise<unknown>;
};

export type WebModelContext = {
  registerTool(tool: RegisteredWebTool, options?: { signal?: AbortSignal }): void | Promise<void>;
};

type PlayerToolState = {
  loaded: boolean;
  playing: boolean;
  trackTitle: string | null;
  aramMode: AramMeasurement;
  activityUnit?: DataUnit; dataUnit?: DataUnit; dataXor?: boolean; entropyUnit?: DataUnit;
};

type Options = {
  context: WebModelContext;
  getState(): PlayerToolState;
  setAramMode(mode: ToolMode): void | Promise<void>;
  setAramOptions?(options: DataOptions): void | Promise<void>;
};

const register = (context: WebModelContext, tool: RegisteredWebTool, signal: AbortSignal) => {
  try {
    void Promise.resolve(context.registerTool(tool, { signal })).catch(() => undefined);
  } catch {
    // WebMCP is optional; an unavailable host must not interrupt the player.
  }
};

export const registerSpcWebTools = ({ context, getState, setAramMode, setAramOptions }: Options) => {
  const lifecycle = new AbortController();
  register(context, {
    name: 'read_spc_player_state',
    title: 'Read SPC player state',
    description: 'Read the currently loaded track, playback status, and visible ARAM mode.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { untrustedContentHint: true, readOnlyHint: true },
    execute: () => getState(),
  }, lifecycle.signal);

  register(context, {
    name: 'set_aram_view',
    title: 'Set ARAM view',
    description: 'Select Activity, Data, or Entropy with independent byte/bit representations. Data supports XOR masks; entropy supports byte diversity or entropy per bit position. Legacy bytes, bits, and xor mode names remain accepted.',
    inputSchema: {
      type: 'object',
      properties: { mode: { type: 'string', enum: [...toolModes] }, activityUnit: { type: 'string', enum: ['byte', 'bit'] }, dataUnit: { type: 'string', enum: ['byte', 'bit'] }, dataXor: { type: 'boolean' }, entropyUnit: { type: 'string', enum: ['byte', 'bit'] } },
      required: ['mode'],
      additionalProperties: false,
    },
    annotations: { untrustedContentHint: false, readOnlyHint: false },
    execute: (input) => {
      const validShape = typeof input === 'object' && input !== null && !Array.isArray(input)
        && Object.keys(input).every(key => ['mode', 'activityUnit', 'dataUnit', 'dataXor', 'entropyUnit'].includes(key)) && 'mode' in input;
      const mode = validShape
        ? (input as { mode?: unknown }).mode
        : undefined;
      const options = validShape ? input as DataOptions : {};
      if (!toolModes.includes(mode as ToolMode) || (options.activityUnit !== undefined && !['byte', 'bit'].includes(options.activityUnit)) || (options.dataUnit !== undefined && !['byte', 'bit'].includes(options.dataUnit)) || (options.entropyUnit !== undefined && !['byte', 'bit'].includes(options.entropyUnit)) || (options.dataXor !== undefined && typeof options.dataXor !== 'boolean')) {
        throw new Error('Invalid ARAM view. Choose activity, data, or entropy with valid byte/bit and XOR options.');
      }
      const changes: DataOptions = {};
      if (options.activityUnit !== undefined) changes.activityUnit = options.activityUnit;
      if (options.dataUnit !== undefined) changes.dataUnit = options.dataUnit;
      if (options.dataXor !== undefined) changes.dataXor = options.dataXor;
      if (options.entropyUnit !== undefined) changes.entropyUnit = options.entropyUnit;
      if (Object.keys(changes).length && !setAramOptions) throw new Error('ARAM representation options are unavailable.');
      return Promise.resolve(setAramMode(mode as ToolMode)).then(() => Object.keys(changes).length ? setAramOptions?.(changes) : undefined).then(() => ({ mode, ...changes }));
    },
  }, lifecycle.signal);

  return lifecycle;
};
