import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";

/**
 * The sidebar when the window crosses the phone width. Narrowed, it folds to
 * its rail, as a session opened that narrow starts: open, it would leave the
 * chat no room. Widened again, one that was folded this way comes back.
 */
export function usePhoneFold(phone: boolean, sidebar: boolean, setSidebar: Dispatch<SetStateAction<boolean>>): void {
  const wasPhone = useRef(phone);
  const folded = useRef(false);
  useEffect(() => {
    if (phone === wasPhone.current) return;
    wasPhone.current = phone;
    if (phone) {
      folded.current = sidebar;
      setSidebar(false);
      return;
    }
    if (folded.current) setSidebar(true);
    folded.current = false;
  }, [phone]);
}
