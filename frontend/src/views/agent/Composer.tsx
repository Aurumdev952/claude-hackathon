import { forwardRef, useImperativeHandle, useRef, useState, type KeyboardEvent } from "react";
import { Button, Textarea } from "@heroui/react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUp, Square } from "lucide-react";
import { SPRING } from "@/lib/motion";

export type ComposerHandle = { focus: () => void; setText: (t: string) => void };

type Props = {
  onSend: (text: string) => void;
  onStop: () => void;
  busy: boolean;
  disabled?: boolean;
  placeholder?: string;
};

/** Message composer (plan §B7): autosizing HeroUI Textarea, Enter sends, Shift+Enter breaks the line, Stop while streaming. */
export const Composer = forwardRef<ComposerHandle, Props>(function Composer({ onSend, onStop, busy, disabled, placeholder = "Ask anything…" }, ref) {
  const [text, setText] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus(), setText: (t: string) => { setText(t); requestAnimationFrame(() => input.current?.focus()); } }), []);
  const canSend = !!text.trim() && !busy && !disabled;
  const send = () => { if (!canSend) return; onSend(text.trim()); setText(""); };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
  };
  return (
    <form className="relative" onSubmit={(e) => { e.preventDefault(); send(); }} aria-label="Message composer">
      <div className="flex items-end gap-2 rounded-[24px] bg-surface border border-border shadow-card pl-2 pr-2 py-2 transition-shadow focus-within:shadow-float focus-within:border-accent/40">
        <Textarea ref={input} value={text} onValueChange={setText} onKeyDown={onKeyDown} minRows={1} maxRows={8} isDisabled={disabled}
                  aria-label="Message the agent" placeholder={placeholder} variant="flat" disableAutosize={false}
                  classNames={{
                    base: "flex-1 min-w-0",
                    inputWrapper: "!bg-transparent shadow-none px-2 py-1.5 min-h-0 !ring-0 !ring-offset-0 data-[hover=true]:!bg-transparent group-data-[focus=true]:!bg-transparent",
                    input: "text-[14.5px] leading-6 text-fg placeholder:text-fg-muted/80 !py-0 outline-none focus:outline-none focus-visible:outline-none",
                  }} />
        <AnimatePresence mode="popLayout" initial={false}>
          {busy ? (
            <motion.div key="stop" initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }} transition={SPRING}>
              <Button isIconOnly radius="full" aria-label="Stop generating" onPress={onStop} className="w-9 h-9 min-w-9 bg-fg text-surface">
                <Square size={13} fill="currentColor" aria-hidden />
              </Button>
            </motion.div>
          ) : (
            <motion.div key="send" initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }} transition={SPRING}>
              <Button isIconOnly radius="full" type="submit" aria-label="Send message" isDisabled={!canSend}
                      className={`w-9 h-9 min-w-9 transition-colors ${canSend ? "bg-accent text-white shadow-tile" : "bg-fg/[0.07] text-fg-muted"}`}>
                <ArrowUp size={17} strokeWidth={2.4} aria-hidden />
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <p className="mt-1.5 text-center text-micro text-fg-muted/90">
        Synthetic data · numbers are checked against tool outputs · <kbd className="font-sans">Shift</kbd>+<kbd className="font-sans">Enter</kbd> for a new line
      </p>
    </form>
  );
});
