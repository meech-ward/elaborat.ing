import { Dialog } from "@base-ui/react/dialog";
import { useAppearance } from "./AppearanceProvider";
import { readingPreferencesSchema } from "./reading";
import "./reading-settings.css";

export function ReadingSettings({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { reading, setReading, resetReading } = useAppearance();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="reading-backdrop" />
        <Dialog.Popup
          className="reading-settings"
          finalFocus={() =>
            document.querySelector<HTMLButtonElement>(
              'button[aria-label="Workbench menu"]',
            )
          }
        >
          <Dialog.Title>Reading preferences</Dialog.Title>
          <Dialog.Description>
            Applies to every rendered note in this browser. Document files and
            themes stay unchanged.
          </Dialog.Description>
          <label>
            Document width
            <select
              aria-label="Document width"
              value={reading.width}
              onChange={(event) =>
                setReading(
                  readingPreferencesSchema.parse({
                    ...reading,
                    width: event.target.value,
                  }),
                )
              }
            >
              <option value="standard">Standard (760px)</option>
              <option value="wide">Wide (1040px)</option>
              <option value="full">Full width</option>
            </select>
          </label>
          <label>
            Text size
            <select
              aria-label="Text size"
              value={reading.textSize}
              onChange={(event) =>
                setReading(
                  readingPreferencesSchema.parse({
                    ...reading,
                    textSize: event.target.value,
                  }),
                )
              }
            >
              <option value="default">Default</option>
              <option value="large">Large</option>
              <option value="larger">Larger</option>
            </select>
          </label>
          <label className="reading-toggle">
            <input
              type="checkbox"
              checked={reading.wideMedia}
              onChange={(event) =>
                setReading({ ...reading, wideMedia: event.target.checked })
              }
            />
            Wide media
          </label>
          <label className="reading-toggle">
            <input
              type="checkbox"
              checked={reading.wideTables}
              onChange={(event) =>
                setReading({ ...reading, wideTables: event.target.checked })
              }
            />
            Wide tables
          </label>
          <p>
            Wide media and tables can extend beyond the text column, but never
            beyond the available viewport.
          </p>
          <div className="reading-actions">
            <button type="button" onClick={resetReading}>
              Reset reading defaults
            </button>
            <Dialog.Close>Done</Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
