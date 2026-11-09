---
name: open-maestri-portal
description: Use a browser portal on the open-maestri canvas to navigate the web, interact with pages, fill forms, and inspect content. Use when the user asks to browse a URL, test a web UI, or interact with a website.
user-invocable: false
---

# open-maestri Portal Browser Automation

Portals are embedded browser nodes on the open-maestri canvas. You can automate them to navigate pages, click elements, fill forms, take screenshots, and inspect the DOM — all without requiring window focus.

Portal name is always required. Run `omaestri list` to see connected portal names.

## Creating a portal

`omaestri portal create "URL" ["Name"]`
create a new portal on the canvas, open it at the given URL, and automatically connect it to your terminal. An optional name can be provided; if omitted it defaults to `Portal-<id>`.

```
omaestri portal create http://localhost:3000
omaestri portal create https://example.com "Docs"
```

After creating, run `omaestri list` to confirm the portal name, then use it with all other portal commands.

## Navigation

`omaestri portal navigate "Portal Name" "URL"`
navigate the portal to a new URL.

`omaestri portal edit "Portal Name" --url "URL"`
update the portal's URL (alias for navigate).

## Inspection

`omaestri portal info "Portal Name"`
get the current URL, page title, and viewport size.

`omaestri portal snapshot "Portal Name"`
get the accessibility tree — a structured, concise view of interactive elements.
**Start here.** The snapshot shows element references like `@e1`, `@e2` that you use in other commands.

`omaestri portal screenshot "Portal Name"`
capture a base64-encoded PNG of the current page.

`omaestri portal html "Portal Name"`
get the full outer HTML of the page.

`omaestri portal text "Portal Name" @e1`
get the text content of a specific element (by `@eN` reference or CSS selector).

## Interaction

Element references use the `@eN` format from `snapshot`, or CSS selectors directly.

`omaestri portal click "Portal Name" @e1`
click an element by reference or CSS selector. Also supports coordinate pairs: `omaestri portal click "Portal" "120,340"`.

`omaestri portal fill "Portal Name" @e1 "value"`
set the value of an input/textarea/select and fire change events.

`omaestri portal type "Portal Name" "text"`
append text to the currently focused element.

`omaestri portal key "Portal Name" "Enter"`
dispatch a keyboard event (e.g., `Enter`, `Escape`, `Tab`, `ArrowDown`) to the focused element.

`omaestri portal hover "Portal Name" @e1`
trigger mouseover/mouseenter events on an element.

`omaestri portal scroll "Portal Name" down [amount]`
scroll the page. Direction: `up` | `down` | `left` | `right`. Amount defaults to 300px.

`omaestri portal drag "Portal Name" @e1 @e2`
drag from one element to another using mouse events.

`omaestri portal wait "Portal Name" @e1 [timeoutMs]`
wait for an element to appear in the DOM. Timeout defaults to 5000ms.

`omaestri portal evaluate "Portal Name" "javascript"`
execute arbitrary JavaScript and return the result.

## Workflow

1. Run `omaestri portal snapshot "Portal Name"` to see the page structure and element references.
2. Use `@eN` references from the snapshot in `click`, `fill`, `text`, etc.
3. After interactions, run `snapshot` again to verify the page updated as expected.
4. Use `screenshot` when you need visual confirmation.
