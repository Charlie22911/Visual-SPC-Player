export const ARAM_MODES = ['activity', 'activity-bits', 'bytes', 'bits', 'xor', 'xor-bits', 'entropy', 'entropy-bits'] as const;
export type AramMode = typeof ARAM_MODES[number];
export const ARAM_MEASUREMENTS = ['activity', 'data', 'entropy'] as const;
export type AramMeasurement = typeof ARAM_MEASUREMENTS[number];
export type DataUnit = 'byte' | 'bit';
export type DataSelection = { mode: AramMeasurement; activityUnit?: DataUnit; dataUnit: DataUnit; dataXor: boolean; entropyUnit: DataUnit };
export const renderingMode = ({ mode, activityUnit, dataUnit, dataXor, entropyUnit }: DataSelection): AramMode =>
  mode === 'activity' ? activityUnit === 'bit' ? 'activity-bits' : 'activity' : mode === 'entropy' ? entropyUnit === 'bit' ? 'entropy-bits' : 'entropy' :
    dataXor ? dataUnit === 'bit' ? 'xor-bits' : 'xor' : dataUnit === 'bit' ? 'bits' : 'bytes';
export const isBitMode = (mode: AramMode) => mode === 'activity-bits' || mode === 'bits' || mode === 'xor-bits' || mode === 'entropy-bits';
export const isActivityMode = (mode: AramMode) => mode === 'activity' || mode === 'activity-bits';
export const isXorMode = (mode: AramMode) => mode === 'xor' || mode === 'xor-bits';
export const isEntropyMode = (mode: AramMode) => mode === 'entropy' || mode === 'entropy-bits';
export type AramGeometry = 'map' | 'waterfall';
export type WaterfallSeconds = 2 | 5 | 10;
export const modeLabels: Record<AramMode, string> = {
  activity: 'Activity', 'activity-bits': 'Bit activity', bytes: 'Byte values', bits: 'Bits', xor: 'XOR bytes', 'xor-bits': 'XOR bits', entropy: 'Byte entropy', 'entropy-bits': 'Bit entropy',
};
