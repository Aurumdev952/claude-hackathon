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

/** Message composer (plan §B7, design v3: a white rounded field with a round solid signal send button): autosizing HeroUI Textarea, Enter sends, Shift+Enter breaks the line, Stop while streaming. */
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
      <div className="flex items-end gap-2 rounded-[28px] bg-surface border border-transparent dark:border-hairline pl-3 pr-2 py-2 transition-colors focus-within:border-hairline dark:focus-within:border-faint/60">
        <Textarea ref={input} value={text} onValueChange={setText} onKeyDown={onKeyDown} minRows={1} maxRows={8} isDisabled={disabled}
                  aria-label="Message the agent" placeholder={placeholder} variant="flat" disableAutosize={false}
                  classNames={{
                    base: "flex-1 min-w-0",
                    inputWrapper: "!bg-transparent shadow-none px-1.5 py-2 min-h-0 !ring-0 !ring-offset-0 data-[hover=true]:!bg-transparent group-data-[focus=true]:!bg-transparent group-data-[focus-visible=true]:!ring-0",
                    input: "text-[15px] leading-6 text-ink placeholder:text-muted !py-0 outline-none focus:outline-none focus-visible:outline-none",
                  }} />
        <AnimatePresence mode="popLayout" initial={false}>
          {busy ? (
            <motion.div key="stop" initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.8, opacity: 0 }} transition={SPRING}>
              <Button isIconOnly radius="full" aria-label="Stop generating" onPress={onStop} className="w-10 h-10 min-w-10 bg-ink text-ink-on">
                <Square size={13} fill="currentColor" aria-hidden />
              </Button>
            </motion.div>
          ) : (
            <motion.div key="send" initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.8, opacity: 0 }} transition={SPRING}>
              <Button isIconOnly radius="full" type="submit" aria-label="Send message" isDisabled={!canSend}
                      className={`w-10 h-10 min-w-10 transition-colors data-[disabled=true]:opacity-100 ${canSend ? "bg-signal-strong text-signal-on data-[hover=true]:bg-signal-text" : "bg-ink/[0.06] dark:bg-tile text-faint"}`}>
                <ArrowUp size={18} strokeWidth={2.25} aria-hidden />
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <p className="mt-2 flex justify-center gap-4 text-micro font-normal text-muted">
        <span>Synthetic data. Numbers are checked against the tool outputs.</span>
        <span className="hidden sm:inline"><kbd className="font-sans">Shift</kbd> + <kbd className="font-sans">Enter</kbd> for a new line</span>
      </p>
    </form>
  );
});
