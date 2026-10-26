/**
 * Cambria-style bidirectional lenses with inline _lc complement for v1/v2 dual-table sync.
 *
 * @example
 * ```ts
 * import * as mod from "@kanchingyg/hotroll/lenses";
 * ```
 *
 * @module
 */

/**
 * SQ-HotRoll Bidirectional Lens Algebra (Cambria-style Put-Get-Put)
 * with Inline Complement Column (_lc JSON) and Wave 2 Symbolic Fused Hub Lenses
 * for N-Hop Overlapping Migrations (v1 <-> v2 <-> v3).
 */

export type RowRecord = Record<string, unknown>;

export interface BidirectionalLens {
  readonly fromEpoch: number;
  readonly toEpoch: number;
  /** Forward projection: transforms v_k row -> v_{k+1} row, preserving dropped fields in _lc */
  forward(row: RowRecord): RowRecord;
  /** Backward projection: transforms v_{k+1} row -> v_k row, preserving v_{k+1}-only fields in _lc */
  backward(row: RowRecord, priorComplement?: RowRecord): RowRecord;
}

function parseComplement(lcRaw: unknown): Record<string, unknown> {
  if (!lcRaw) return {};
  if (typeof lcRaw === "string") {
    try {
      return JSON.parse(lcRaw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (typeof lcRaw === "object") {
    return { ...(lcRaw as Record<string, unknown>) };
  }
  return {};
}

/**
 * Lens Operator 1: Split / Merge string column (e.g., full_name <-> first_name, last_name)
 * with inline _lc preservation of extra target attributes.
 */
export function createSplitMergeLens(opts: {
  fromEpoch: number;
  toEpoch: number;
  sourceCol: string;
  targetFirstCol: string;
  targetLastCol: string;
  delimiter?: string;
  addedDefaults?: Record<string, unknown>;
}): BidirectionalLens {
  const delim = opts.delimiter ?? " ";
  const defaults = opts.addedDefaults ?? {};

  return {
    fromEpoch: opts.fromEpoch,
    toEpoch: opts.toEpoch,
    forward(row: RowRecord): RowRecord {
      const out: RowRecord = { ...row };
      const lc = parseComplement(row._lc);
      const rawVal = String(row[opts.sourceCol] ?? "");
      const idx = rawVal.indexOf(delim);
      if (idx >= 0) {
        out[opts.targetFirstCol] = rawVal.slice(0, idx);
        out[opts.targetLastCol] = rawVal.slice(idx + delim.length);
      } else {
        out[opts.targetFirstCol] = rawVal;
        out[opts.targetLastCol] = "";
      }
      delete out[opts.sourceCol];

      // Restore any v_{k+1}-specific fields previously stashed in v_k._lc
      for (const [k, defVal] of Object.entries(defaults)) {
        if (k in lc && lc[k] !== undefined) {
          out[k] = lc[k];
          delete lc[k];
        } else if (!(k in out) || out[k] === undefined) {
          out[k] = defVal;
        }
      }
      out._row_ver = Number(row._row_ver ?? 1);
      out._lc = JSON.stringify(lc);
      return out;
    },
    backward(row: RowRecord): RowRecord {
      const out: RowRecord = { ...row };
      const lc = parseComplement(row._lc);
      const fn = String(row[opts.targetFirstCol] ?? "");
      const ln = String(row[opts.targetLastCol] ?? "");
      out[opts.sourceCol] = ln.length > 0 ? `${fn}${delim}${ln}` : fn;
      delete out[opts.targetFirstCol];
      delete out[opts.targetLastCol];

      // Stash v_{k+1}-only attributes inside inline _lc so a subsequent v_k update never clobbers them
      for (const k of Object.keys(defaults)) {
        if (k in row && row[k] !== undefined) {
          lc[k] = row[k];
        }
        delete out[k];
      }
      out._row_ver = Number(row._row_ver ?? 1);
      out._lc = JSON.stringify(lc);
      return out;
    },
  };
}

/**
 * Lens Operator 2: Rename + Type Cast / Default Injection Lens
 */
export function createRenameAndEnrichLens(opts: {
  fromEpoch: number;
  toEpoch: number;
  renames: Record<string, string>; // oldName -> newName
  addedDefaults: Record<string, unknown>;
}): BidirectionalLens {
  const reverseRenames: Record<string, string> = {};
  for (const [oldK, newK] of Object.entries(opts.renames)) {
    reverseRenames[newK] = oldK;
  }

  return {
    fromEpoch: opts.fromEpoch,
    toEpoch: opts.toEpoch,
    forward(row: RowRecord): RowRecord {
      const out: RowRecord = { ...row };
      const lc = parseComplement(row._lc);
      for (const [oldK, newK] of Object.entries(opts.renames)) {
        if (oldK in out) {
          out[newK] = out[oldK];
          delete out[oldK];
        }
      }
      for (const [k, defVal] of Object.entries(opts.addedDefaults)) {
        if (k in lc && lc[k] !== undefined) {
          out[k] = lc[k];
          delete lc[k];
        } else if (!(k in out) || out[k] === undefined) {
          out[k] = defVal;
        }
      }
      out._row_ver = Number(row._row_ver ?? 1);
      out._lc = JSON.stringify(lc);
      return out;
    },
    backward(row: RowRecord): RowRecord {
      const out: RowRecord = { ...row };
      const lc = parseComplement(row._lc);
      for (const [newK, oldK] of Object.entries(reverseRenames)) {
        if (newK in out) {
          out[oldK] = out[newK];
          delete out[newK];
        }
      }
      for (const k of Object.keys(opts.addedDefaults)) {
        if (k in row && row[k] !== undefined) {
          lc[k] = row[k];
        }
        delete out[k];
      }
      out._row_ver = Number(row._row_ver ?? 1);
      out._lc = JSON.stringify(lc);
      return out;
    },
  };
}

/**
 * Composes two adjacent bidirectional lenses L_{a->b} and L_{b->c} into L_{a->c}.
 */
export function composeLenses(l1: BidirectionalLens, l2: BidirectionalLens): BidirectionalLens {
  if (l1.toEpoch !== l2.fromEpoch) {
    throw new Error(`Lens epoch mismatch: ${l1.toEpoch} !== ${l2.fromEpoch}`);
  }
  return {
    fromEpoch: l1.fromEpoch,
    toEpoch: l2.toEpoch,
    forward(row: RowRecord): RowRecord {
      return l2.forward(l1.forward(row));
    },
    backward(row: RowRecord): RowRecord {
      return l1.backward(l2.backward(row));
    },
  };
}

/**
 * Wave 2 Upgrade 3: Symbolic Fused Hub Lens Registry for N-Hop Overlapping Migrations.
 * Pre-composes all pairs (u -> v) in an active sliding window (N <= 3) so any write
 * from epoch u fans out directly into bound parameters for all active epochs in 1 batch.
 */
export class SymbolicFusedHubLens {
  private readonly epochs: number[];
  private readonly pairMap = new Map<string, (row: RowRecord) => RowRecord>();

  constructor(adjacentLenses: BidirectionalLens[]) {
    const epochSet = new Set<number>();
    for (const l of adjacentLenses) {
      epochSet.add(l.fromEpoch);
      epochSet.add(l.toEpoch);
    }
    this.epochs = [...epochSet].sort((a, b) => a - b);

    // Pre-compile direct projections for all (src, dst) pairs in the window
    for (const src of this.epochs) {
      for (const dst of this.epochs) {
        const key = `${src}->${dst}`;
        if (src === dst) {
          this.pairMap.set(key, (r) => ({ ...r }));
        } else if (src < dst) {
          const chain = adjacentLenses.filter(
            (l) => l.fromEpoch >= src && l.toEpoch <= dst
          );
          this.pairMap.set(key, (r) => {
            let cur = { ...r };
            for (const step of chain) {
              cur = step.forward(cur);
            }
            return cur;
          });
        } else {
          const chain = adjacentLenses
            .filter((l) => l.toEpoch <= src && l.fromEpoch >= dst)
            .reverse();
          this.pairMap.set(key, (r) => {
            let cur = { ...r };
            for (const step of chain) {
              cur = step.backward(cur);
            }
            return cur;
          });
        }
      }
    }
  }

  public project(sourceEpoch: number, targetEpoch: number, row: RowRecord): RowRecord {
    const fn = this.pairMap.get(`${sourceEpoch}->${targetEpoch}`);
    if (!fn) {
      throw new Error(`No fused lens path for ${sourceEpoch}->${targetEpoch}`);
    }
    return fn(row);
  }

  /**
   * Fans out a mutation originating at `sourceEpoch` into transformed row payloads
   * for every active epoch in the sliding window with 0 trigger recursion.
   */
  public fanOutMutation(
    sourceEpoch: number,
    row: RowRecord,
    nextRowVer: number
  ): Map<number, RowRecord> {
    const result = new Map<number, RowRecord>();
    const baseRow = { ...row, _row_ver: nextRowVer };
    for (const targetEpoch of this.epochs) {
      const projected = this.project(sourceEpoch, targetEpoch, baseRow);
      projected._row_ver = nextRowVer;
      result.set(targetEpoch, projected);
    }
    return result;
  }
}
