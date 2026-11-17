# BridgeWeb sync

`tool-access-ui`'s shadcn primitives and design tokens come from Agent Studio's BridgeWeb (`BridgeWeb/` in the AgentStudio repository). Both use shadcn `base-mira` on Base UI, with no Radix.

**Synced at:** agentstudio `d77e97bb320e1788b475f72aaf1ee042a0b61f14` (13 Nov 2026).

## What is synced

- **Primitives:** `src/components/ui/` — `alert`, `button`, `card`, `checkbox`, `field`, `input`, `input-group`, `label`, `separator`, `skeleton`, `sonner`, `textarea`, `tooltip`. These are BridgeWeb's files.
- **Tokens:** `src/panel-theme.css` — the token layers (primitives → roles → contexts, the `@theme inline` registrations and the base layer) are BridgeWeb's `src/app/bridge-app.css`.
- **Token mirrors:** `src/design-tokens/bridge-design-palette.ts` and `bridge-design-row-metrics.ts` are copied unchanged. `bridge-design-tokens.unit.test.ts` holds them equal to `panel-theme.css`, which is BridgeWeb's design-token check pointed at this theme.

## Intentional differences

| Where | Difference | Why |
|---|---|---|
| All primitives | `import { cn } from 'cn'` instead of `@/lib/utils`; sibling imports use `@tool-access-ui/components/ui/<name>` instead of `@/components/ui/<name>.js` | Package aliases. The `cn` package is a drop-in for BridgeWeb's `twMerge(clsx(...))` and resolves Tailwind conflicts the same way. |
| All primitives | Import order | The repository formatter sorts imports, and `cn` is now a package import. Code bodies and import sets are identical. |
| `panel-theme.css` | `@source "./**/*.ts(x)"` instead of `"../**/*.ts(x)"` | The file sits in `src/`, not `src/app/`. |
| `panel-theme.css` | Leaves out BridgeWeb's app-shell CSS: `html, body, #root { height: 100%; overflow: hidden }`, the review-comparison animations and the `.bridge-markdown-*` document styles | They belong to the BridgeWeb app shell, not the design system. The full-height, overflow-hidden shell would clip scrolling pages. |
| `server.ts` | Exports `inputVariants`, as BridgeWeb's `input` does, instead of our former `inputClassName` | It follows BridgeWeb's API. |
| Primitives BridgeWeb doesn't have | `alert-dialog`, `badge`, `dialog`, `empty`, `select`, `sheet`, `sidebar`, `spinner`, `table`, `tabs` stay this package's own (shadcn `base-mira`, Base UI) | There is no BridgeWeb counterpart at the synced commit. |
| BridgeWeb components not adopted | `annotation-gutter`, `avatar`, `collapsible`, `combobox`, `dom-slot-portal`, `drawer`, `dropdown-menu`, `item-content`, `popover`, `resizable`, `scroll-area`, `status-badge`, `switch`, `toggle`, `toggle-group` | Nothing here uses them yet. Copy them unchanged when a view needs one. |

## Re-checking the sync

Set `AGENTSTUDIO_CHECKOUT` to an AgentStudio checkout you control. From the Switchboard root, for each synced primitive `f`:

```sh
git -C "$AGENTSTUDIO_CHECKOUT" show d77e97bb3:BridgeWeb/src/components/ui/$f.tsx \
  | sed -E -e "s#from '@/lib/utils(\.js)?'#from 'cn'#" \
           -e "s#from '@/components/ui/([a-z-]+)(\.js)?'#from '@tool-access-ui/components/ui/\1'#" \
  > /tmp/$f.bridge.tsx
diff <(grep -v -E '^import |^$' /tmp/$f.bridge.tsx) <(grep -v -E '^import |^$' packages/tool-access-ui/src/components/ui/$f.tsx)
diff <(grep -E '^import ' /tmp/$f.bridge.tsx | sort) <(grep -E '^import ' packages/tool-access-ui/src/components/ui/$f.tsx | sort)
```

Both diffs are empty at the synced commit. For the tokens, `diff` the first 322 lines of `panel-theme.css` against BridgeWeb's `bridge-app.css`: only the `@source` lines differ.
