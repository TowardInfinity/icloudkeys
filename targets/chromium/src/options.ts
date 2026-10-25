import { NAME } from "./name.ts";
import { loadSettings, saveSettings, setBrowserAutoFill, type Settings } from "./settings.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const box = (key: keyof Settings) => $<HTMLInputElement>(key);
const error = $<HTMLParagraphElement>("error");

document.title = `${NAME} Settings`;
$("inPageAutoFill-detail").textContent =
  `Offer passwords, codes and Hide My Email in a list under the field. You can always fill from the ${NAME} toolbar button.`;
$("browserAutoFillOff-detail").textContent =
  `Stop the browser saving and filling passwords, addresses and cards, so its own prompts don't cover ${NAME}'s list. Turning this back off restores the browser's settings.`;

function fail(e: unknown): void {
  error.textContent = e instanceof Error ? e.message : String(e);
  error.hidden = false;
}

const settings = await loadSettings();
for (const key of Object.keys(settings) as (keyof Settings)[]) box(key).checked = settings[key];
box("keyButton").disabled = !settings.inPageAutoFill;

box("inPageAutoFill").addEventListener("change", (e) => {
  const on = (e.target as HTMLInputElement).checked;
  box("keyButton").disabled = !on;
  void saveSettings({ inPageAutoFill: on }).catch(fail);
});
box("keyButton").addEventListener("change", (e) => {
  void saveSettings({ keyButton: (e.target as HTMLInputElement).checked }).catch(fail);
});
box("browserAutoFillOff").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const off = input.checked;
  error.hidden = true;
  try {
    // `privacy` is optional and asked for here, the one place it's used
    if (off && !(await chrome.permissions.request({ permissions: ["privacy"] }))) {
      input.checked = false;
      return;
    }
    if (!off && !(await chrome.permissions.contains({ permissions: ["privacy"] }))) return void saveSettings({ browserAutoFillOff: false });
    await setBrowserAutoFill(off);
    await saveSettings({ browserAutoFillOff: off });
  } catch (err) {
    input.checked = !off;
    fail(err);
  }
});
