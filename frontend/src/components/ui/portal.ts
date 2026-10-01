import { createContext, useContext } from "react";

/** Where kit overlays (InfoHint popovers / tooltips, DetailModal, stage tooltips) portal to. Undefined = document.body.
 * A surface that goes browser-fullscreen (the case 3D stage) provides itself here, because only the fullscreen element's
 * subtree is rendered while it is fullscreen. */
export const PortalContainerContext = createContext<HTMLElement | undefined>(undefined);
export const usePortalContainer = () => useContext(PortalContainerContext);
