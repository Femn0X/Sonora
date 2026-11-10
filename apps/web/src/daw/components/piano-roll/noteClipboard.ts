import type { ClipboardNote } from "./selection";

/**
 * Session clipboard for notes. Module-level on purpose: copy in one clip, switch to another clip (the editor
 * remounts), paste there. Not persisted and not shared between users.
 */
let current: ClipboardNote[] = [];

export const getNoteClipboard = (): ClipboardNote[] => current;
export const setNoteClipboard = (notes: ClipboardNote[]) => {
  current = notes;
};
