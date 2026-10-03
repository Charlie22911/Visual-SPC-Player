import { ACTIVITY_BYTES, ARAM_BYTES, STATE_BYTES, type Snapshot } from '../audio/protocol';
import { decodeStatePayload, type EmulatorState } from '../audio/state';
import type { VisualStream } from '../audio/visualStream';

export type LiveStateProps = {
  stream: VisualStream;
  generation: number;
  onError(message: string): void;
};

// Paint in the same presentation callback as ARAM. React owns the panel
// structure; these subscribers own its rapidly changing text and meter values.
export function subscribeLiveState(
  { stream, generation, onError }: LiveStateProps,
  paint: (state: EmulatorState | null) => void,
) {
  const update = (snapshot: Snapshot) => {
    if (snapshot.generation !== generation) return;
    try {
      paint(decodeStatePayload(new Uint8Array(snapshot.payload, ARAM_BYTES + ACTIVITY_BYTES, STATE_BYTES)));
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  };
  if (stream.latest?.generation === generation) update(stream.latest);
  else paint(null);
  return stream.subscribe(update);
}

export function setLiveText(node: HTMLElement, text: string) {
  if (node.textContent !== text) node.textContent = text;
}
