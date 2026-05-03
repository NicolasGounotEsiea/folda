import { convertFileSrc } from "@tauri-apps/api/core";
import { clsx } from "clsx";
import { FileImage, Film, Maximize2, Minimize2, Music, X, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store/useStore";

export const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "ico"];
export const VIDEO_EXTS = ["mp4", "webm", "mov", "mkv", "m4v", "avi"];
export const AUDIO_EXTS = ["mp3", "wav", "flac", "ogg", "m4a", "aac", "opus"];


export function MediaViewer() {
  const { openedFile, closeFile } = useStore();
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState(true);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0, px: 0, py: 0 });

  useEffect(() => {
    setZoom(1);
    setFit(true);
    setPan({ x: 0, y: 0 });
  }, [openedFile?.id]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeFile();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [closeFile]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setFit(false);
    setZoom((z) => Math.min(8, Math.max(0.1, z * (e.deltaY < 0 ? 1.15 : 0.87))));
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    dragging.current = true;
    dragStart.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
  }, [pan]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging.current) return;
    setPan({
      x: dragStart.current.px + (e.clientX - dragStart.current.x),
      y: dragStart.current.py + (e.clientY - dragStart.current.y),
    });
  }, []);

  const handleMouseUp = useCallback(() => { dragging.current = false; }, []);

  if (!openedFile) return null;

  const ext = openedFile.extension.toLowerCase();
  const isVideo = VIDEO_EXTS.includes(ext);
  const isAudio = AUDIO_EXTS.includes(ext);
  const url = convertFileSrc(openedFile.path);

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-surface-0">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 h-10 bg-surface-1 border-b border-border-subtle shrink-0">
        {isVideo
          ? <Film size={13} className="text-purple-400 shrink-0" />
          : isAudio
          ? <Music size={13} className="text-cyan-400 shrink-0" />
          : <FileImage size={13} className="text-pink-400 shrink-0" />
        }
        <span className="text-[12px] text-text-primary font-medium truncate flex-1 min-w-0">
          {openedFile.name}
        </span>
        <span className="text-[10px] text-text-muted bg-surface-3 px-1.5 py-0.5 rounded shrink-0">
          {ext.toUpperCase()}
        </span>

        {!isVideo && !isAudio && (
          <>
            <button
              onClick={() => { setFit(false); setZoom((z) => Math.min(8, z * 1.25)); }}
              className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
              title="Zoom in"
            ><ZoomIn size={13} /></button>
            <button
              onClick={() => { setFit(false); setZoom((z) => Math.max(0.1, z * 0.8)); }}
              className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
              title="Zoom out"
            ><ZoomOut size={13} /></button>
            <button
              onClick={() => { setFit(true); setPan({ x: 0, y: 0 }); }}
              className={clsx(
                "w-6 h-6 flex items-center justify-center rounded transition-colors",
                fit ? "text-accent bg-accent/10" : "text-text-muted hover:text-text-primary hover:bg-surface-3"
              )}
              title="Fit to window"
            ><Minimize2 size={12} /></button>
            <button
              onClick={() => { setFit(false); setZoom(1); setPan({ x: 0, y: 0 }); }}
              className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
              title="Actual size (100%)"
            ><Maximize2 size={12} /></button>
            {!fit && (
              <span className="text-[10px] text-text-muted w-10 text-right shrink-0">
                {Math.round(zoom * 100)}%
              </span>
            )}
          </>
        )}

        <button
          onClick={closeFile}
          className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors shrink-0 ml-1"
          title="Close (Escape)"
        ><X size={13} /></button>
      </div>

      {/* Media area */}
      <div
        className="flex-1 overflow-hidden flex items-center justify-center bg-[#0f0f0f] relative"
        onWheel={isVideo || isAudio ? undefined : handleWheel}
        onMouseDown={isVideo || isAudio ? undefined : handleMouseDown}
        onMouseMove={isVideo || isAudio ? undefined : handleMouseMove}
        onMouseUp={isVideo || isAudio ? undefined : handleMouseUp}
        onMouseLeave={isVideo || isAudio ? undefined : handleMouseUp}
        style={{ cursor: isVideo || isAudio ? "default" : fit ? "default" : "grab" }}
      >
        {isAudio ? (
          <div className="flex flex-col items-center gap-6 px-8 w-full max-w-lg">
            <Music size={56} className="text-cyan-400 opacity-40" />
            <span className="text-[13px] text-text-secondary text-center truncate w-full">
              {openedFile.name}
            </span>
            <audio
              key={openedFile.path}
              src={url}
              controls
              autoPlay={false}
              className="w-full"
              style={{ accentColor: "#06b6d4" }}
            />
          </div>
        ) : isVideo ? (
          <video
            key={openedFile.path}
            src={url}
            controls
            autoPlay={false}
            className="max-w-full max-h-full"
            style={{ outline: "none" }}
          />
        ) : (
          <div
            style={{
              transform: fit
                ? "none"
                : `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: "center center",
              transition: dragging.current ? "none" : "transform 0.1s ease",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: fit ? "100%" : "auto",
              height: fit ? "100%" : "auto",
            }}
          >
            <img
              key={openedFile.path}
              src={url}
              alt={openedFile.name}
              draggable={false}
              style={{
                maxWidth: fit ? "100%" : "none",
                maxHeight: fit ? "100%" : "none",
                objectFit: fit ? "contain" : "none",
                userSelect: "none",
              }}
              onError={(e) => {
                (e.target as HTMLImageElement).alt = "Failed to load image";
              }}
            />
          </div>
        )}
      </div>

      {/* Status bar */}
      <div className="flex items-center gap-4 px-3 h-6 bg-surface-1 border-t border-border-subtle shrink-0">
        <span className="text-[10px] text-text-muted">{openedFile.name}</span>
        <div className="flex-1" />
        {!isVideo && !isAudio && !fit && (
          <span className="text-[10px] text-text-muted">{Math.round(zoom * 100)}%</span>
        )}
        <span className="text-[10px] text-text-muted">
          {isVideo ? "Vidéo" : isAudio ? "Audio" : "Image"}
        </span>
      </div>
    </div>
  );
}
