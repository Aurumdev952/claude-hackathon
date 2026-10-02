import { lazy, Suspense, type ReactNode } from "react";
import { Button, Modal, ModalBody, ModalContent, ModalHeader, useDisclosure } from "@heroui/react";
import { Clapperboard } from "lucide-react";
import { modalMotion } from "@/lib/motion";
import { usePortalContainer } from "@/components/ui/portal";
import type { VideoKind, VideoParams } from "./types";

// The Player, Remotion and the compositions load only when a modal opens (separate chunk).
const VideoStudio = lazy(() => import("./VideoStudio"));

export type VideoModalProps = {
  isOpen: boolean;
  onOpenChange?: (open: boolean) => void;
  onClose?: () => void;
  /** "patient" (doctor role: params {patient_id}) or "ministry" / "ministry_vertical" (params {from, to, sex, age, def}). */
  kind: VideoKind;
  params: VideoParams;
  title?: ReactNode;
};

/** Data video modal (design v3): an instant in-browser preview with @remotion/player, then Export MP4 on the render
 * server with a progress bar, Download and Copy link. Role headers come from the current session, so the server builds
 * the same props the API allows this user to see. */
export function VideoModal({ isOpen, onOpenChange, onClose, kind, params, title }: VideoModalProps) {
  const portal = usePortalContainer();
  const vertical = kind === "ministry_vertical";
  return (
    <Modal isOpen={isOpen} portalContainer={portal} onOpenChange={onOpenChange} onClose={onClose} size={vertical ? "3xl" : "5xl"} backdrop="opaque"
           placement="center" scrollBehavior="inside" motionProps={modalMotion as any}
           classNames={{
             base: "rounded-modal bg-surface shadow-float max-h-[92vh] dark:border dark:border-hairline",
             backdrop: "bg-[rgb(21_23_28/0.32)]",
             header: "px-7 pt-6 pb-2 flex items-center gap-3 pr-16",
             body: "px-7 pt-2 pb-7",
             closeButton: "top-5 right-5 w-9 h-9 rounded-full border border-hairline text-ink hover:bg-tile active:bg-tile-hover",
           }}>
      <ModalContent>
        {() => (
          <>
            <ModalHeader>
              <span className="w-9 h-9 shrink-0 rounded-full border border-hairline text-ink grid place-items-center" aria-hidden>
                <Clapperboard size={17} />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-[22px] leading-[28px] font-semibold tracking-[-0.01em] text-ink truncate">
                  {title ?? (kind === "patient" ? "Case summary video" : "Surveillance reel")}
                </h2>
                <div className="text-label text-muted mt-0.5">Synthetic data. The preview plays here; Export renders an MP4 you can download or share.</div>
              </div>
            </ModalHeader>
            <ModalBody>
              <Suspense fallback={<StudioSkeleton vertical={vertical} />}>
                <VideoStudio kind={kind} params={params} />
              </Suspense>
            </ModalBody>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}

export function StudioSkeleton({ vertical }: { vertical: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      <div className={`rounded-tile bg-tile animate-pulse mx-auto w-full ${vertical ? "max-w-[min(100%,40vh)] aspect-[9/16]" : "aspect-video"}`} />
      <div className="h-11 rounded-full bg-tile animate-pulse w-48 self-end" />
    </div>
  );
}

/** A "Create video" button that owns its modal (for screens that only need the entry point). */
export function VideoButton({ kind, params, title, label = "Create video", size = "sm", className }: {
  kind: VideoKind; params: VideoParams; title?: ReactNode; label?: string; size?: "sm" | "md"; className?: string;
}) {
  const d = useDisclosure();
  return (
    <>
      <Button size={size} radius="full" variant="bordered" onPress={d.onOpen} startContent={<Clapperboard size={14} aria-hidden />}
              className={`border-hairline text-ink font-medium ${className ?? ""}`}>
        {label}
      </Button>
      {d.isOpen && <VideoModal isOpen={d.isOpen} onOpenChange={d.onOpenChange} kind={kind} params={params} title={title} />}
    </>
  );
}
