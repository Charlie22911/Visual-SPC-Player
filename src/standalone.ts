export type StandaloneAssets = {
  workletBase64: string;
  wasmBase64: string;
  noticesBase64: string;
  sourceBase64: string;
  buildId: string;
};

declare global {
  interface Window {
    __SPC_STANDALONE_ASSETS__?: StandaloneAssets;
  }
}

export const getStandaloneAssets = () => window.__SPC_STANDALONE_ASSETS__;

export const isStandaloneBuild = () => Boolean(getStandaloneAssets());

export const decodeStandaloneWasm = (base64: string) => {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
};

export const decodeStandaloneText = (base64: string) =>
  new TextDecoder().decode(decodeStandaloneWasm(base64));

export const standaloneTextUrl = (base64: string) => `data:text/plain;base64,${base64}`;
