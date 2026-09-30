# Extractable components

## ResponsiveHeader
- Source: `frontend/src/components/ResponsiveHeader.jsx`
- Category: layout
- Description: Mobile and desktop navigation toggle with permitted links
- Extractable props: route (string, default: "home")
- Hardcoded: menu labels come from route config; CSS classes `topbar`, `mobile-menu-toggle`

## Modal
- Source: `frontend/src/components/Modal.jsx`
- Category: layout
- Description: Portal dialog with backdrop, focus trap, and Escape dismiss
- Extractable props: labelledBy (string), describedBy (string)
- Hardcoded: `modal-backdrop`, `modal`, role=dialog

## Field
- Source: `frontend/src/components/Field.jsx`
- Category: basic
- Description: Label, hint, and error for a single control
- Extractable props: label (string), error (string), hint (string)
- Hardcoded: `field`, `field-hint`, `field-error`

## StatusBadge
- Source: `frontend/src/components/StatusBadge.jsx`
- Category: basic
- Description: Workflow status pill
- Extractable props: status (string, default: "open")
- Hardcoded: status copy and `workflow-badge` classes
