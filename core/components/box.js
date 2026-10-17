//The box a component is drawn in, as a size class. A component does not ask how big the screen is: it asks how big
//ITS box is, so the same component fits a docked panel, a floating window, another browser window and a phone.
//CSS uses `@container (max-width: …)` (the host is the container, see AgoraInstance); code reads `data-box`.
export const BOX_COMPACT = 420;     //px: narrower than this is "compact" (a phone's width)
export const BOX_WIDE = 720;        //px: from this on it is "wide"

export const boxSize = width => width < BOX_COMPACT ? 'compact' : width < BOX_WIDE ? 'regular' : 'wide';
