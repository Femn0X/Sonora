import type { EditorCommand } from "./commands";

/**
 * Minimal undo/redo stack. Kept deliberately simple for MVP (spec §24: don't
 * overbuild) — stores inverse commands, not full manifest snapshots, so it
 * stays cheap across a long editing session. Some command types don't yet
 * have an inverse (see commands.ts `invertCommand`); those simply aren't
 * undoable yet, which is an accepted, documented MVP gap rather than a bug.
 */
export class CommandHistory {
  private undoStack: EditorCommand[] = [];
  private redoStack: EditorCommand[] = [];
  private maxSize = 200;

  push(inverse: EditorCommand | null) {
    if (!inverse) return;
    this.undoStack.push(inverse);
    if (this.undoStack.length > this.maxSize) this.undoStack.shift();
    this.redoStack = []; // any new action invalidates the redo stack
  }

  /** Used by redo: restores an undo entry WITHOUT discarding the remaining redo stack. */
  pushUndoKeepRedo(inverse: EditorCommand | null) {
    if (!inverse) return;
    this.undoStack.push(inverse);
    if (this.undoStack.length > this.maxSize) this.undoStack.shift();
  }

  popUndo(): EditorCommand | undefined {
    return this.undoStack.pop();
  }

  pushRedo(inverse: EditorCommand | null) {
    if (inverse) this.redoStack.push(inverse);
  }

  popRedo(): EditorCommand | undefined {
    return this.redoStack.pop();
  }

  canUndo() {
    return this.undoStack.length > 0;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }
}
