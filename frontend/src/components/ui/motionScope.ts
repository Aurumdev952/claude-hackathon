import { createContext, useContext } from "react";

/** Who animates a card's entrance: "grid" = a staggering parent (BentoGrid) drives variants, "item" = a parent already
 * animated it (GridItem), undefined = the card animates itself. */
export type MotionScope = "grid" | "item" | undefined;
export const MotionScopeContext = createContext<MotionScope>(undefined);
export const useMotionScope = () => useContext(MotionScopeContext);
