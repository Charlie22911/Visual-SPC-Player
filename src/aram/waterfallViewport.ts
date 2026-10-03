export type AddressWindow = { start: number; span: number };
export const fitWindow = (): AddressWindow => ({ start: 0, span: 65536 });
export const plotColumns = (width: number) => Math.max(1, Math.min(65536, Math.floor(width) || 1));
const clampWindow = (start: number, span: number, columns = 1): AddressWindow => {
  const size = Math.max(columns, Math.min(65536, Math.round(span)));
  return { start: Math.max(0, Math.min(65536 - size, Math.round(start))), span: size };
};
export function columnRange(w: AddressWindow, columns: number, x: number): [number, number] {
  return [w.start + Math.floor(x * w.span / columns), w.start + Math.floor((x + 1) * w.span / columns)];
}
export function zoomWindow(w: AddressWindow, columns: number, factor: number, anchor01: number): AddressWindow {
  if (!Number.isFinite(factor) || factor <= 0) return w;
  const u = Math.max(0, Math.min(1, anchor01));
  const span = Math.max(columns, Math.min(65536, Math.round(w.span / factor)));
  return clampWindow(w.start + u * w.span - u * span, span, columns);
}
export const panWindow = (w: AddressWindow, deltaAddresses: number) => clampWindow(w.start + deltaAddresses, w.span);
export const oneToOneWindow = (w: AddressWindow, columns: number) => clampWindow(w.start + (w.span - columns) / 2, columns, columns);
export const resizeWindow = (w: AddressWindow, oldColumns: number, newColumns: number) => {
  const span = Math.max(newColumns, Math.min(65536, Math.round(w.span / Math.max(1, oldColumns) * newColumns)));
  return clampWindow(w.start + (w.span - span) / 2, span, newColumns);
};
