# The 18 parts

Reference for the designer-1 skill. Load it only when you place or build a part.

Source: the parts list in the atris-design catalog (`components/catalog.json`) and the props in `components/react/src/parts/*.tsx`. Package: `@atris/design-react`. Sheets: `styles.css`, then `parts-forms.css`, `parts-overlays.css`, `parts-navigation.css`.

Every part also takes `id`, `className`, `style`, `ref` and `data-*` marks.

## forms

| part | job | needs | props | callbacks |
|---|---|---|---|---|
| `Button` | Do one action, named by its label even when only an icon shows. | `label` | `label` `hideLabel` `icon` `tone` `size` `loading` `disabled` | `onClick` |
| `Field` | Give any control a name, a hint and an error that are read with it. | `label` `children` | `label` `hideLabel` `hint` `error` `required` `disabled` `labelAs` | `children(control, ids)` |
| `Input` | Take one line of text with its name, hint and error. | `label` | `label` `hideLabel` `hint` `error` `type` `size` `value` `defaultValue` `readOnly` `required` `disabled` | `onValueChange` |
| `Textarea` | Take several lines of text with its name, hint and error. | `label` | `label` `hideLabel` `hint` `error` `size` `value` `defaultValue` `readOnly` `required` `disabled` | `onValueChange` |
| `Checkbox` | Turn one choice on or off, with a mixed state for a parent box. | `label` | `label` `hideLabel` `hint` `error` `checked` `defaultChecked` `name` `value` `required` `readOnly` `disabled` | `onCheckedChange` |
| `Switch` | Turn a setting on or off at once. | `label` | `label` `hideLabel` `hint` `checked` `defaultChecked` `name` `value` `readOnly` `disabled` | `onCheckedChange` |
| `RadioGroup` | Pick one choice from a short list that stays in view. | `label` `options` | `label` `hideLabel` `options` `hint` `error` `value` `defaultValue` `name` `required` `readOnly` `disabled` `orientation` | `onValueChange` |
| `Select` | Pick one choice from a list that opens from a button. | `label` `options` | `label` `hideLabel` `options` `placeholder` `value` `defaultValue` `open` `defaultOpen` `name` `required` `readOnly` `disabled` `size` `hint` `error` | `onValueChange` `onOpenChange` |

## overlays

| part | job | needs | props | callbacks |
|---|---|---|---|---|
| `Dialog` | Hold one focused decision over the page until it is answered. | `label` | `label` `description` `trigger` `footer` `open` `defaultOpen` `dismissOnBackdrop` `size` `disabled` `closeLabel` `initialFocusRef` | `onOpenChange` |
| `Popover` | Show a small panel of controls tied to its button. | `label` `children` | `label` `trigger` `open` `defaultOpen` `side` `align` `disabled` | `onOpenChange` |
| `Menu` | List the actions behind one button. | `label` `items` | `label` `items` `open` `defaultOpen` `side` `align` `disabled` | `onSelect` `onOpenChange` |
| `Tooltip` | Add a short tip to one control on hover or focus. | `label` `children` | `label` `type` `open` `defaultOpen` `delay` `side` `align` `disabled` | `onOpenChange` |
| `Toast` | Tell the person what just happened, then step aside. | `label` | `label` `description` `tone` `open` `defaultOpen` `duration` `action` `dismissLabel` | `action.onSelect` `onOpenChange` |

## navigation

| part | job | needs | props | callbacks |
|---|---|---|---|---|
| `Tabs` | Switch between views of one thing without leaving the page. | `label` `items` | `label` `items` `value` `defaultValue` `activation` `orientation` `size` `disabled` | `onValueChange` |
| `Accordion` | Open one answer at a time from a list of questions. | `label` `items` | `label` `items` `type` `value` `defaultValue` `collapsible` `headingLevel` `disabled` | `onValueChange` |
| `SegmentedControl` | Pick one of a few views in a single pill. | `label` `options` | `label` `options` `value` `defaultValue` `name` `required` `readOnly` `disabled` `size` | `onValueChange` |
| `Combobox` | Type to find and pick one choice from a long list. | `label` `options` | `label` `hideLabel` `options` `placeholder` `value` `defaultValue` `open` `defaultOpen` `name` `required` `readOnly` `disabled` `size` `emptyMessage` | `onValueChange` `onOpenChange` |
| `Slider` | Set a number in a range by dragging or with the keys. | `label` | `label` `hideLabel` `min` `max` `step` `pageStep` `value` `defaultValue` `formatValue` `name` `readOnly` `disabled` `size` | `onValueChange` |

## companions

- `DialogClose` takes the `Button` props and closes the dialog it sits in. Put it in `footer`.
- `ToastRegion` takes `label`, `hotkey`, `placement` (`bottom-end`, `top-end`, `bottom-center`). Every `Toast` sits inside one.
- `Field` wraps a control the parts do not cover. Its `children` is a function that gets the control props (`id`, `aria-describedby`, `aria-invalid`, `aria-required`, `disabled`) to spread on the real element.
- `Checkbox` takes `"indeterminate"` for `checked` on a parent box.

## shared vocabulary

- `partSizes`: `small`, `default`, `large`.
- `partTones`: `default`, `primary`, `quiet`, `success`, `danger`.
- entry: `{ value, label, disabled?, data? }`. `Menu` items add `hint` and `tone`. `Select` and `RadioGroup` options add `hint`. `Tabs` and `Accordion` items add `content`.
- empty choice: `null`.
