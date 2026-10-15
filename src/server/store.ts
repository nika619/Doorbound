// The household's state on disk: routines, learned durations and today's departure.
// Validated on the way in (the file is input too), written atomically, writes coalesced.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod/v4';
import type { Departure, Household } from '../core/departure.ts';
import { WINDOW, type History } from '../core/learn.ts';

export const LIMITS = { people: 8, steps: 15, name: 32, helpers: 7, historyKeys: 8 * 15 * 2 } as const;

const id = z.string().regex(/^[a-z0-9-]{1,32}$/);
const name = z.string().trim().min(1).max(LIMITS.name);

export const stepSchema = z.object({
  id,
  name,
  statedSec: z.number().int().min(30).max(7200),
  quick: z.object({ name, sec: z.number().int().min(30).max(7200) }).optional(),
  canWait: z.boolean().optional(),
  optional: z.boolean().optional(),
  helpers: z.array(id).max(LIMITS.helpers).optional(),
});
export const householdSchema = z.object({
  people: z.array(z.object({ id, name, steps: z.array(stepSchema).max(LIMITS.steps) })).max(LIMITS.people),
});

const ms = z.number().int().nonnegative();
export const taskSchema = z.object({
  key: z.string().max(80),
  stepId: id,
  forPerson: id,
  name,
  sec: z.number().int().min(0).max(86_400),
  state: z.enum(['todo', 'done', 'later', 'skipped']),
  doneAtMs: ms.optional(),
  quick: z.boolean().optional(),
  notBeforeMs: ms.optional(),
});
export const laneSchema = z.object({ personId: id, startedAtMs: ms, tasks: z.array(taskSchema).max(LIMITS.people * LIMITS.steps) });
export const changeSchema = z.object({ kind: z.enum(['quick', 'handoff', 'later', 'skip']), taskKey: z.string().max(80), name, from: id, to: id.optional(), savedSec: z.number().int() });
const departureCore = z.object({ name, gateMs: ms, startedAtMs: ms, rev: z.number().int().nonnegative(), lanes: z.array(laneSchema).max(LIMITS.people) });
export const departureSchema = departureCore.extend({
  reroute: z
    .object({ atMs: ms, rev: z.number().int(), changes: z.array(changeSchema).max(LIMITS.people * LIMITS.steps), stillLateSec: z.number().int().nonnegative(), before: departureCore.extend({ reroute: z.null() }) })
    .nullable(),
});

const fileSchema = z.object({
  version: z.literal(1),
  household: householdSchema,
  history: z.array(z.tuple([z.string().max(80), z.array(z.number().positive().max(86_400)).max(WINDOW)])).max(LIMITS.historyKeys),
  departure: departureSchema.nullable(),
});

export class Store {
  household: Household = { people: [] };
  history: History = new Map();
  departure: Departure | null = null;
  /** Changes on every edit; starts from the clock so it never repeats across restarts. Screens compare it to skip work. */
  rev = Date.now();
  private writing: Promise<void> | null = null;
  private again = false;

  private constructor(private readonly file: string) {}

  static async open(dir: string): Promise<Store> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const store = new Store(join(dir, 'household.json'));
    let raw: string;
    try {
      raw = await readFile(store.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return store;
      throw e;
    }
    const parsed = fileSchema.safeParse(safeJson(raw));
    if (!parsed.success) {
      // Never throw away a household's data silently: keep the bad file aside and start clean.
      const aside = `${store.file}.unreadable-${Date.now()}`;
      await rename(store.file, aside);
      console.error(`household.json failed validation; kept as ${aside}`);
      return store;
    }
    store.household = parsed.data.household as Household;
    store.history = new Map(parsed.data.history);
    store.departure = parsed.data.departure as Departure | null;
    return store;
  }

  touch(): void {
    this.rev++;
  }

  /** Persist. Atomic (write then rename) and coalesced: at most one write in flight, one queued. */
  save(): Promise<void> {
    if (this.writing) {
      this.again = true;
      return this.writing;
    }
    this.writing = (async () => {
      do {
        this.again = false;
        const body = JSON.stringify({ version: 1, household: this.household, history: [...this.history], departure: this.departure });
        const tmp = `${this.file}.tmp`;
        await writeFile(tmp, body, { mode: 0o600 });
        await rename(tmp, this.file);
      } while (this.again);
    })().finally(() => {
      this.writing = null;
    });
    return this.writing;
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
