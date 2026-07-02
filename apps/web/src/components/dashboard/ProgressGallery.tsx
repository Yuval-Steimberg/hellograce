import { useEffect, useRef, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import { format, parseISO } from "date-fns";
import { dashboardApi, type ProgressPhoto } from "@/lib/dashboardApi";
import { fileToFullAndThumb } from "@/lib/image";

const card = "rounded-2xl border border-sand bg-white p-5 shadow-[0_1px_2px_rgba(36,31,27,0.04)]";
const fmt = (d: string) => { try { return format(parseISO(d), "MMM d, yyyy"); } catch { return d; } };

export function ProgressGallery() {
  const [photos, setPhotos] = useState<ProgressPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ full: string; thumb: string } | null>(null);
  const [note, setNote] = useState("");
  const [weight, setWeight] = useState("");
  const [open, setOpen] = useState<ProgressPhoto | null>(null);
  const [openFull, setOpenFull] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try { const { photos } = await dashboardApi.listPhotos(); setPhotos(photos); }
    catch { /* best-effort — an empty gallery is fine */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    try { setPending(await fileToFullAndThumb(file)); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't read that photo"); }
    finally { if (fileRef.current) fileRef.current.value = ""; }
  };

  const savePending = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const w = weight.trim() ? Number(weight) : undefined;
      const { photo } = await dashboardApi.addProgressPhoto(pending.full, pending.thumb, note.trim() || undefined, Number.isFinite(w) ? w : undefined);
      setPhotos((p) => [photo, ...p]);
      setPending(null); setNote(""); setWeight("");
      toast.success("Progress photo saved 🤍");
    } catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't save that"); } finally { setBusy(false); }
  };

  const openPhoto = async (p: ProgressPhoto) => {
    setOpen(p); setOpenFull(null);
    try { const { dataUrl } = await dashboardApi.getPhoto(p.id); setOpenFull(dataUrl); }
    catch { setOpenFull(p.thumbUrl); }
  };

  const remove = async (id: string) => {
    try {
      await dashboardApi.deletePhoto(id);
      setPhotos((p) => p.filter((x) => x.id !== id));
      setOpen(null);
      toast.success("Photo deleted");
    } catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't delete that"); }
  };

  return (
    <div className={card}>
      <div className="mb-1 flex items-center justify-between">
        <h3 className="font-serif text-lg text-foreground">Progress photos</h3>
        <button onClick={() => fileRef.current?.click()} className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-white">+ Add photo</button>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
      </div>
      <p className="mb-4 text-sm text-muted-foreground">Private to you — a before/after record of how far you've come. Never logged, never shared.</p>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : photos.length === 0 && !pending ? (
        <div className="flex h-40 flex-col items-center justify-center rounded-xl border-2 border-dashed border-sand bg-secondary/30 text-center">
          <span className="text-3xl">📸</span>
          <p className="mt-2 max-w-xs text-sm text-muted-foreground">Add your first progress photo. Come back over time to see how far you've come.</p>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {photos.map((p) => (
            <button key={p.id} onClick={() => openPhoto(p)}
              className="group relative aspect-square overflow-hidden rounded-xl border border-sand bg-secondary/40">
              {p.thumbUrl ? (
                <img src={p.thumbUrl} alt={p.note ?? "Progress photo"} className="h-full w-full object-cover transition-transform group-hover:scale-105" />
              ) : (
                <div className="flex h-full items-center justify-center text-2xl">🖼️</div>
              )}
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/55 to-transparent px-2 py-1 text-left">
                <span className="text-[10px] font-medium text-white">{fmt(p.takenAt)}</span>
                {p.weightLbs != null && <span className="ml-1 text-[10px] text-white/80">· {p.weightLbs} lb</span>}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Save-pending sheet */}
      <AnimatePresence>
        {pending && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center" onClick={() => !busy && setPending(null)}>
            <motion.div initial={{ y: 24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 24, opacity: 0 }}
              className="max-h-[92vh] w-full max-w-sm overflow-y-auto rounded-2xl bg-white p-5" onClick={(e) => e.stopPropagation()}>
              <h4 className="mb-3 font-serif text-lg text-foreground">Save this photo</h4>
              <img src={pending.full} alt="New progress" className="mb-4 max-h-64 w-full rounded-xl object-cover" />
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note (optional)"
                className="mb-3 h-11 w-full rounded-xl border border-sand px-3 text-sm outline-none focus:border-primary" />
              <input value={weight} onChange={(e) => setWeight(e.target.value)} inputMode="decimal" placeholder="Weight today, lbs (optional)"
                className="mb-4 h-11 w-full rounded-xl border border-sand px-3 text-sm outline-none focus:border-primary" />
              <div className="flex gap-3">
                <button onClick={() => setPending(null)} disabled={busy} className="h-11 flex-1 rounded-full border border-sand text-sm font-medium text-foreground/70">Cancel</button>
                <button onClick={savePending} disabled={busy} className="h-11 flex-1 rounded-full bg-primary text-sm font-medium text-white disabled:opacity-50">{busy ? "Saving…" : "Save"}</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Lightbox */}
      <AnimatePresence>
        {open && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setOpen(null)}>
            <motion.div initial={{ scale: 0.96, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.96, opacity: 0 }}
              className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white" onClick={(e) => e.stopPropagation()}>
              <div className="flex min-h-[240px] items-center justify-center bg-black/5">
                {openFull ? <img src={openFull} alt={open.note ?? "Progress photo"} className="max-h-[60vh] w-full object-contain" />
                  : <p className="py-16 text-sm text-muted-foreground">Loading…</p>}
              </div>
              <div className="flex items-center justify-between p-4">
                <div>
                  <p className="text-sm font-medium text-foreground">{fmt(open.takenAt)}{open.weightLbs != null && <span className="text-muted-foreground"> · {open.weightLbs} lb</span>}</p>
                  {open.note && <p className="mt-0.5 text-sm text-muted-foreground">{open.note}</p>}
                </div>
                <button onClick={() => remove(open.id)} className="rounded-full border border-sand px-4 py-2 text-sm text-[#B05A41]">Delete</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
