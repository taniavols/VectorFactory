# Vector Factory

Adobe Illustrator CEP panel for building placeholder-based vector templates and exporting them to Adobe Stock.

## How it works

The panel works with a document that has these layers:

- **ARTWORK** — where you keep the source artwork you want to place.
- **MASTER** — holds the single currently selected element (set via _Set Element_).
- **PLACEHOLDERS** — groups that define where the element is placed. Each group contains a target named `S` (copy placeholder appearance) or `SK` (keep original appearance). A group can be a simple template or a clipping template (a clipped group containing the target).
- **BG** / **FG** (optional) — background and foreground layers copied into the export.

## Panel buttons

- **Set Element** — moves the selected object into MASTER and refreshes `preview.png`.
- **Generate** — fills every placeholder with the MASTER element, fitting and rotating it to the target, then hides the targets.
- **Clear** — removes generated art and reveals the targets again.
- **Hide / Show** — toggles the placeholder targets' visibility.
- **Export** — for each artboard, creates an EPS (Illustrator 10) + JPG preview pair scaled to 25 MP, ready for Adobe Stock.

## Layout

```
index.html            Panel UI
css/app.css           Panel styles
js/app.js             Panel logic (calls the JSX scripts)
jsx/VF_Common.jsx     Shared generate / show / hide logic
jsx/VF_Generate.jsx   Generate action
jsx/VF_Clear.jsx      Clear action
jsx/VF_Hide.jsx       Hide targets
jsx/VF_Show.jsx       Show targets
jsx/VF_SetElement.jsx Set MASTER element + capture preview
jsx/VF_Export.jsx     Export artboards to EPS + JPG
CSXS/manifest.xml     CEP extension manifest
lib/CSInterface-4.0.0.js  CEP host bridge
```
