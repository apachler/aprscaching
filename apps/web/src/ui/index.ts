// SPDX-License-Identifier: AGPL-3.0-or-later
/** Shared UI primitives (governed by .claude/rules/ui-ux.md + css.md). Import from here. */
export { Switch } from "./Switch.js";
export { Group, Row, Advanced } from "./Group.js";
export { Panel } from "./Panel.js";
export { Button, type ButtonVariant } from "./Button.js";
export { Segmented, type SegmentOption } from "./Segmented.js";
export { Tabs, tabPanelId, type TabItem } from "./Tabs.js";
export { ChipToggle } from "./ChipToggle.js";
export { Badge, TierBadge, CallVerifiedBadge, TIER_NAME, TIER_DESC, LicenceBadge, licenceLabel } from "./Badge.js";
export { Card } from "./Card.js";
export { EmptyState } from "./EmptyState.js";
export { ErrorState } from "./ErrorState.js";
export { ErrorBoundary } from "./ErrorBoundary.js";
export { LoadMore } from "./LoadMore.js";
export { usePaged, type PageResult } from "./usePaged.js";
export { useLoad } from "./useLoad.js";
export { usePoll } from "./usePoll.js";
export { ToastProvider, useToast, TOAST_EVENT } from "./Toast.js";
// The one icon set: line icons, with a CP437 glyph in Phosphor where one is given (see Icon).
export { Icon, ICON_NAMES, type IconName } from "./Icon.js";
export { Tour, tourSeen, type TourStep } from "./Tour.js";
export { TOUR_STEPS } from "./tourSteps.js";
export { useModalDialog } from "./useModalDialog.js";
export { Sheet } from "./Sheet.js";
export { ConfirmProvider, useConfirm, useChoice } from "./Confirm.js";
export { Disclosure } from "./Disclosure.js";
export { CommandBlock } from "./CommandBlock.js";
export { copyText } from "./clipboard.js";
export { TierChip, MinTier, DtBars, Stat, type Tier } from "./operator.js";
