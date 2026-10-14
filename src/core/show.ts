// The show model. Pure functions: state is derived from stored timestamps and "now",
// so the server needs no timers and every screen can redraw the same moment.

export type Scene =
  | { kind: 'title'; headline: string; subline?: string }
  | { kind: 'countdown'; label: string; durationMs: number }
  | { kind: 'scoreboard'; home: string; away: string; homeScore: number; awayScore: number };

export interface Cue {
  id: string;
  label: string;
  scene: Scene;
  /** Epoch ms for a timed cue. Absent means it fires only when called by name. */
  atMs?: number;
  firedAtMs?: number;
}

export interface Show {
  id: string;
  title: string;
  /** Bumped on every change, so a screen can tell whether it is stale. */
  rev: number;
  scene: Scene;
  sceneStartedAtMs: number;
  pausedAtMs: number | null;
  pausedTotalMs: number;
  cues: Cue[];
}

let seq = 0;
const newId = (prefix: string, nowMs: number) => `${prefix}_${nowMs.toString(36)}${(seq++).toString(36)}`;

export function createShow(title: string, scene: Scene, nowMs: number): Show {
  return { id: newId('show', nowMs), title, rev: 1, scene, sceneStartedAtMs: nowMs, pausedAtMs: null, pausedTotalMs: 0, cues: [] };
}

/** Milliseconds the current scene has been running, excluding paused time. */
export function elapsedMs(show: Show, nowMs: number): number {
  const end = show.pausedAtMs ?? nowMs;
  return Math.max(0, end - show.sceneStartedAtMs - show.pausedTotalMs);
}

/** Time left on a countdown scene; 0 for any other scene or once it has run out. */
export function remainingMs(show: Show, nowMs: number): number {
  return show.scene.kind === 'countdown' ? Math.max(0, show.scene.durationMs - elapsedMs(show, nowMs)) : 0;
}

export function setScene(show: Show, scene: Scene, startedAtMs: number): Show {
  return { ...show, rev: show.rev + 1, scene, sceneStartedAtMs: startedAtMs, pausedAtMs: null, pausedTotalMs: 0 };
}

export function pause(show: Show, nowMs: number): Show {
  return show.pausedAtMs === null ? { ...show, rev: show.rev + 1, pausedAtMs: nowMs } : show;
}

export function resume(show: Show, nowMs: number): Show {
  if (show.pausedAtMs === null) return show;
  return { ...show, rev: show.rev + 1, pausedAtMs: null, pausedTotalMs: show.pausedTotalMs + (nowMs - show.pausedAtMs) };
}

export function addCue(show: Show, cue: Omit<Cue, 'id' | 'firedAtMs'>, nowMs: number): Show {
  return { ...show, rev: show.rev + 1, cues: [...show.cues, { ...cue, id: newId('cue', nowMs) }] };
}

/** Fire a cue by id or by label (case-insensitive). Returns null when nothing matches. */
export function fireCue(show: Show, idOrLabel: string, nowMs: number): Show | null {
  const key = idOrLabel.trim().toLowerCase();
  const cue = show.cues.find((c) => c.id === idOrLabel || c.label.toLowerCase() === key);
  if (!cue) return null;
  const next = setScene(show, cue.scene, nowMs);
  return { ...next, cues: next.cues.map((c) => (c.id === cue.id ? { ...c, firedAtMs: nowMs } : c)) };
}

/**
 * Bring a show up to date: fire every timed cue that is due, in time order.
 * Each scene starts at its scheduled time, not at "now", so nothing drifts
 * when no screen was looking at the moment the cue came due.
 */
export function resolve(show: Show, nowMs: number): Show {
  const due = show.cues
    .filter((c) => c.atMs !== undefined && c.firedAtMs === undefined && c.atMs <= nowMs)
    .sort((a, b) => a.atMs! - b.atMs!);
  let out = show;
  for (const cue of due) {
    out = setScene(out, cue.scene, cue.atMs!);
    out = { ...out, cues: out.cues.map((c) => (c.id === cue.id ? { ...c, firedAtMs: cue.atMs } : c)) };
  }
  return out;
}

/** What a screen needs to draw this instant. */
export interface StageState {
  show: Show | null;
  serverNowMs: number;
  elapsedMs: number;
  remainingMs: number;
}

export function stageState(show: Show | null, nowMs: number): StageState {
  return { show, serverNowMs: nowMs, elapsedMs: show ? elapsedMs(show, nowMs) : 0, remainingMs: show ? remainingMs(show, nowMs) : 0 };
}
