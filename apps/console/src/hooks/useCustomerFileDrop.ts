import { useRef, useState, type ChangeEvent, type DragEvent } from 'react';

/**
 * Taking a customer file by drop or by the picker, the same on New campaign's Customers step and
 * a campaign's Add contacts (CS7): one file at a time, only while `ready`, with the drag-over
 * mark, and the picker cleared after each pick, so choosing the same file again (after a refusal
 * that says to try again) fires a change.
 *
 * `ready` is render state (the ingest's `idle` phase), so two drop or change events can both see
 * it before React commits `uploading`; the lock here takes the first file only.
 */
export function useCustomerFileDrop(ready: boolean, onPickFile: (file: File) => Promise<void> | void) {
  const [dragOver, setDragOver] = useState(false);
  const pickingRef = useRef(false);

  const pick = async (file: File | undefined) => {
    if (!file || !ready || pickingRef.current) return;
    pickingRef.current = true;
    setDragOver(false);
    try {
      await onPickFile(file);
    } finally {
      pickingRef.current = false;
    }
  };

  /** Spread on the drop zone. */
  const dropzoneProps = {
    'data-drag-over': dragOver || undefined,
    onDragOver: (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      if (ready && !pickingRef.current) setDragOver(true);
    },
    onDragLeave: () => setDragOver(false),
    onDrop: (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      setDragOver(false);
      void pick(event.dataTransfer.files[0]);
    },
  };

  /** The file input's `onChange`. */
  const onInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // A browser fires no change for the file already chosen; cleared, a retry is a new pick.
    event.target.value = '';
    void pick(file);
  };

  return { dragOver, dropzoneProps, onInputChange };
}
